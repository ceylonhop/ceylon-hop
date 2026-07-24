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
            (code, corridor_id, from_place, to_place, date, slot, min_seats, capacity, seat_price, note, cutoff_at, created_by, created_at, updated_at)
          values
            (${code}, ${args.corridorId}, ${args.fromPlace}, ${args.toPlace}, ${args.date}, ${args.slot},
             ${args.minSeats}, ${args.capacity}, ${args.seatPrice}, ${args.note}, ${args.cutoffAt}, ${args.createdBy}, ${now}, ${now})
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
    const rows = await this.sql<ListRow[]>`
      select * from ride_list where status = 'gathering' order by created_at desc`;
    const from = filter.from ? norm(filter.from) : null;
    const horizon = filter.when === 'week' ? 7 : filter.when === 'fortnight' ? 14 : null;
    const lists = rows
      .map(toList)
      .filter((l) => (from ? norm(l.fromPlace) === from : true))
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

  async addMember(listId: string, args: AddMemberArgs, now: Date = new Date()): Promise<RideMember | null> {
    // Guarded, oversell-safe insert (pooled analogue of holdSeats): the row is inserted only
    // when live seats + requested ≤ capacity. ON CONFLICT (list_id, sub) reactivates a
    // scratched member (idempotent for a live one). Callers that want the friendly
    // "already-on-this-list" short-circuit check getByCode first (route does).
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
        where list_id = ${listId} and status in ('held', 'charged')
      ) + ${args.seats} <= (select capacity from ride_list where id = ${listId})
      on conflict (list_id, sub) do update set
        status = 'held',
        seats = excluded.seats,
        preferred_time = excluded.preferred_time,
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
