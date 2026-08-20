import { randomUUID } from 'node:crypto';
import type { Sql } from './client';
import {
  makeCode,
  type RideList,
  type RideMember,
  type RideListStatus,
  type MemberStatus,
  type Slot,
} from '../domain/rideList';
import {
  type RideListRepo,
  type CreateListArgs,
  type AddMemberArgs,
  type RideListWithMembers,
  type ListFilter,
  type RidePreapproval,
} from './rideListRepo';

// Postgres impl of RideListRepo — same shape/patterns as PostgresDepartureRepo.
// The oversell-safe pooled hold is a single guarded INSERT…SELECT (the pooled
// analogue of holdSeats' guarded UPDATE): a member row is inserted only when the
// live-member seat sum + requested seats still fits the van's capacity.

const DAY_MS = 86_400_000;
const norm = (s: string) => s.trim().toLowerCase();

interface ListRow {
  id: string; code: string; corridor_id: string; from_place: string; to_place: string;
  date: string; slot: string; locked_time: string | null; min_seats: number; capacity: number;
  seat_price: number; status: string; note: string | null; cutoff_at: Date;
  created_by: string | null; created_at: Date; updated_at: Date;
}
interface MemberRow {
  id: string; list_id: string; position: number; sub: string; first_name: string; country: string;
  email: string; photo_url: string | null; preferred_time: string | null; seats: number;
  preapproval_ref: string | null; status: string; joined_at: Date;
  preapproval_order_id: string | null; preapproval_expires_at: Date | null;
}

const toList = (r: ListRow): RideList => ({
  id: r.id, code: r.code, corridorId: r.corridor_id, fromPlace: r.from_place, toPlace: r.to_place,
  date: r.date, slot: r.slot as Slot, lockedTime: r.locked_time, minSeats: r.min_seats,
  capacity: r.capacity, seatPrice: r.seat_price, status: r.status as RideListStatus, note: r.note,
  cutoffAt: new Date(r.cutoff_at), createdBy: r.created_by,
  createdAt: new Date(r.created_at), updatedAt: new Date(r.updated_at),
});
const toMember = (r: MemberRow): RideMember => ({
  id: r.id, listId: r.list_id, position: r.position, sub: r.sub, firstName: r.first_name,
  country: r.country, email: r.email, photoUrl: r.photo_url, preferredTime: r.preferred_time,
  seats: r.seats, preapprovalRef: r.preapproval_ref, status: r.status as MemberStatus,
  preapprovalOrderId: r.preapproval_order_id,
  preapprovalExpiresAt: r.preapproval_expires_at ? new Date(r.preapproval_expires_at) : null,
  joinedAt: new Date(r.joined_at),
});

export class PostgresRideListRepo implements RideListRepo {
  constructor(private readonly sql: Sql) {}

  private async membersFor(listIds: string[]): Promise<Map<string, RideMember[]>> {
    const byList = new Map<string, RideMember[]>();
    if (listIds.length === 0) return byList;
    const rows = await this.sql<MemberRow[]>`
      select * from ride_list_member where list_id in ${this.sql(listIds)} order by position asc`;
    for (const r of rows) {
      const m = toMember(r);
      const arr = byList.get(m.listId) ?? [];
      arr.push(m);
      byList.set(m.listId, arr);
    }
    return byList;
  }

  private async withMembers(lists: RideList[]): Promise<RideListWithMembers[]> {
    const members = await this.membersFor(lists.map((l) => l.id));
    return lists.map((list) => ({ list, members: members.get(list.id) ?? [] }));
  }

  async createList(args: CreateListArgs, now: Date = new Date()): Promise<RideList> {
    // Public code = route initials + 4 digits; retry on the (rare) unique collision.
    for (let attempt = 0; attempt < 6; attempt++) {
      const suffix = String(1000 + Math.floor(parseInt(randomUUID().replace(/[^0-9]/g, '').slice(0, 6) || '0', 10) % 9000));
      const code = makeCode(args.fromPlace, args.toPlace, suffix);
      try {
        const rows = await this.sql<ListRow[]>`
          insert into ride_list
            (code, corridor_id, from_place, to_place, date, slot, min_seats, capacity, seat_price, status, note, cutoff_at, created_by, created_at, updated_at)
          values
            (${code}, ${args.corridorId}, ${args.fromPlace}, ${args.toPlace}, ${args.date}, ${args.slot},
             ${args.minSeats}, ${args.capacity}, ${args.seatPrice}, ${args.initialStatus ?? 'gathering'}, ${args.note}, ${args.cutoffAt}, ${args.createdBy}, ${now}, ${now})
          returning *`;
        return toList(rows[0]);
      } catch (err) {
        // 23505 = unique_violation (code clash) → try a fresh suffix
        if ((err as { code?: string }).code === '23505' && attempt < 5) continue;
        throw err;
      }
    }
    throw new Error('could not allocate a unique list code');
  }

  async getByCode(code: string): Promise<RideListWithMembers | null> {
    const rows = await this.sql<ListRow[]>`select * from ride_list where code = ${code}`;
    if (!rows[0]) return null;
    return (await this.withMembers([toList(rows[0])]))[0];
  }

  async getById(id: string): Promise<RideListWithMembers | null> {
    const rows = await this.sql<ListRow[]>`select * from ride_list where id = ${id}`;
    if (!rows[0]) return null;
    return (await this.withMembers([toList(rows[0])]))[0];
  }

  async listOpen(filter: ListFilter = {}, now: Date = new Date()): Promise<RideListWithMembers[]> {
    // Board scale is dozens of lists — read the open set and filter/sort in JS (keeps the
    // query simple; no dynamic SQL). Matches InMemoryRideListRepo semantics exactly.
    // Confirmed lists stay on the board (see the in-memory repo for why); cancelled/expired drop.
    const rows = await this.sql<ListRow[]>`
      select * from ride_list where status in ('gathering','confirmed') order by created_at desc`;
    const from = filter.from ? norm(filter.from) : null;
    const to = filter.to ? norm(filter.to) : null;
    const horizon = filter.when === 'week' ? 7 : filter.when === 'fortnight' ? 14 : null;
    const lists = rows
      .map(toList)
      .filter((l) => (from ? norm(l.fromPlace) === from : true))
      .filter((l) => (to ? norm(l.toPlace) === to : true))
      .filter((l) => {
        if (!horizon) return true;
        const days = (new Date(`${l.date}T00:00:00Z`).getTime() - now.getTime()) / DAY_MS;
        return days <= horizon;
      });
    return this.withMembers(lists);
  }

  async findOpenByRoute(fromPlace: string, toPlace: string, date?: string): Promise<RideList | null> {
    const rows = await this.sql<ListRow[]>`
      select * from ride_list
      where status = 'gathering'
        and lower(from_place) = ${norm(fromPlace)}
        and lower(to_place) = ${norm(toPlace)}
        ${date ? this.sql`and date = ${date}` : this.sql``}
      order by created_at asc limit 1`;
    return rows[0] ? toList(rows[0]) : null;
  }

  async listForMember(sub: string): Promise<RideListWithMembers[]> {
    const rows = await this.sql<ListRow[]>`
      select l.* from ride_list l
      join ride_list_member m on m.list_id = l.id
      where m.sub = ${sub} and m.status in ('held', 'charged')
      order by l.created_at desc`;
    return this.withMembers(rows.map(toList));
  }

  async addMember(listId: string, args: AddMemberArgs, now: Date = new Date()): Promise<RideMember | null> {
    // Guarded, oversell-safe insert (pooled analogue of holdSeats): the row is inserted only
    // when *other* travellers' live seats + requested ≤ capacity — excluding this traveller's
    // own seats is what lets them change 1→2 on a van that has room. ON CONFLICT (list_id, sub)
    // both reactivates a scratched member and applies a live member's seat change, keeping
    // their position; an omitted preferred time leaves their existing vote standing.
    const rows = await this.sql<MemberRow[]>`
      insert into ride_list_member
        (list_id, position, sub, first_name, country, email, photo_url, preferred_time, seats, preapproval_ref, status, joined_at)
      select
        ${listId},
        (select coalesce(max(position), 0) + 1 from ride_list_member where list_id = ${listId}),
        ${args.sub}, ${args.firstName}, ${args.country}, ${args.email}, ${args.photoUrl ?? null},
        ${args.preferredTime ?? null}, ${args.seats}, ${args.preapprovalRef ?? null}, 'held', ${now}
      where (
        select coalesce(sum(seats), 0) from ride_list_member
        where list_id = ${listId} and status in ('held', 'charged') and sub <> ${args.sub}
      ) + ${args.seats} <= (select capacity from ride_list where id = ${listId})
      on conflict (list_id, sub) do update set
        status = 'held',
        seats = excluded.seats,
        preferred_time = coalesce(excluded.preferred_time, ride_list_member.preferred_time),
        preapproval_ref = coalesce(excluded.preapproval_ref, ride_list_member.preapproval_ref),
        joined_at = excluded.joined_at
      returning *`;
    if (!rows[0]) return null;
    await this.touch(listId, now);
    return toMember(rows[0]);
  }

  async removeMember(listId: string, sub: string): Promise<boolean> {
    const rows = await this.sql<{ id: string }[]>`
      update ride_list_member set status = 'scratched'
      where list_id = ${listId} and sub = ${sub} and status in ('held', 'charged')
      returning id`;
    if (rows.length) await this.touch(listId, new Date());
    return rows.length > 0;
  }

  async beginMemberPreapproval(
    listId: string,
    args: AddMemberArgs,
    orderId: string,
    expiresAt: Date,
    now: Date = new Date(),
  ): Promise<RideMember | null> {
    const rows = await this.sql<MemberRow[]>`
      insert into ride_list_member
        (list_id, position, sub, first_name, country, email, photo_url, preferred_time, seats,
         preapproval_ref, preapproval_order_id, preapproval_expires_at, status, joined_at)
      select
        ${listId},
        (select coalesce(max(position), 0) + 1 from ride_list_member where list_id = ${listId}),
        ${args.sub}, ${args.firstName}, ${args.country}, ${args.email}, ${args.photoUrl ?? null},
        ${args.preferredTime ?? null}, ${args.seats}, null, ${orderId}, ${expiresAt},
        'preapproval_pending', ${now}
      where (
        select coalesce(sum(seats), 0) from ride_list_member
        where list_id = ${listId} and sub <> ${args.sub}
          and (status in ('held', 'charged') or (status = 'preapproval_pending' and preapproval_expires_at > ${now}))
      ) + ${args.seats} <= (select capacity from ride_list where id = ${listId})
      on conflict (list_id, sub) do update set
        first_name = excluded.first_name,
        country = excluded.country,
        email = excluded.email,
        photo_url = excluded.photo_url,
        preferred_time = coalesce(excluded.preferred_time, ride_list_member.preferred_time),
        seats = excluded.seats,
        preapproval_order_id = excluded.preapproval_order_id,
        preapproval_expires_at = excluded.preapproval_expires_at,
        status = 'preapproval_pending',
        joined_at = excluded.joined_at
      returning *`;
    if (!rows[0]) return null;
    await this.touch(listId, now);
    return toMember(rows[0]);
  }

  async getByPreapprovalOrder(orderId: string): Promise<RidePreapproval | null> {
    const rows = await this.sql<(MemberRow & { list_json: ListRow })[]>`
      select m.*, row_to_json(l) as list_json
      from ride_list_member m join ride_list l on l.id = m.list_id
      where m.preapproval_order_id = ${orderId}`;
    if (!rows[0]) return null;
    return { list: toList(rows[0].list_json), member: toMember(rows[0]) };
  }

  async approveMemberPreapproval(
    orderId: string,
    ref: string,
    now: Date = new Date(),
  ): Promise<RideListWithMembers | null> {
    const found = await this.getByPreapprovalOrder(orderId);
    if (!found) return null;
    if (found.member.status === 'held' || found.member.status === 'charged') {
      await this.sql`
        update ride_list set status = 'gathering', updated_at = ${now}
        where id = ${found.list.id} and status = 'pending_payment'`;
      return this.getById(found.list.id);
    }
    const rows = await this.sql<MemberRow[]>`
      update ride_list_member m
      set preapproval_ref = ${ref}, preapproval_expires_at = null, status = 'held', joined_at = ${now}
      where m.preapproval_order_id = ${orderId}
        and m.status = 'preapproval_pending'
        and m.preapproval_expires_at > ${now}
        and (
          select coalesce(sum(seats), 0) from ride_list_member
          where list_id = m.list_id and sub <> m.sub and status in ('held', 'charged')
        ) + m.seats <= (select capacity from ride_list where id = m.list_id)
      returning m.*`;
    if (!rows[0]) {
      await this.failMemberPreapproval(orderId, now);
      return this.getById(found.list.id);
    }
    await this.sql`
      update ride_list set status = 'gathering', updated_at = ${now}
      where id = ${found.list.id} and status = 'pending_payment'`;
    return this.getById(found.list.id);
  }

  async failMemberPreapproval(orderId: string, now: Date = new Date()): Promise<void> {
    const found = await this.getByPreapprovalOrder(orderId);
    if (!found) return;
    await this.sql`
      update ride_list_member set status = 'preapproval_failed'
      where preapproval_order_id = ${orderId} and status = 'preapproval_pending'`;
    await this.sql`
      update ride_list set status = 'cancelled', updated_at = ${now}
      where id = ${found.list.id} and status = 'pending_payment'`;
  }

  async setStatus(id: string, status: RideListStatus): Promise<void> {
    await this.sql`update ride_list set status = ${status}, updated_at = now() where id = ${id}`;
  }

  async lockDeparture(id: string, time: string): Promise<void> {
    await this.sql`update ride_list set locked_time = ${time}, updated_at = now() where id = ${id}`;
  }

  async setMemberStatus(listId: string, sub: string, status: MemberStatus): Promise<void> {
    await this.sql`update ride_list_member set status = ${status} where list_id = ${listId} and sub = ${sub}`;
  }

  async dueForCutoff(now: Date): Promise<RideListWithMembers[]> {
    const rows = await this.sql<ListRow[]>`
      select * from ride_list where status = 'gathering' and cutoff_at <= ${now}`;
    return this.withMembers(rows.map(toList));
  }

  private async touch(id: string, now: Date): Promise<void> {
    await this.sql`update ride_list set updated_at = ${now} where id = ${id}`;
  }
}
