import { randomUUID } from 'node:crypto';
import {
  type RideList,
  type RideMember,
  type RideListStatus,
  type MemberStatus,
  type Slot,
  committedSeats,
  countsForSeat,
  makeCode,
} from '../domain/rideList';

// ============================================================================
// RideListRepo — persistence for the Ride Board, modelled exactly on
// DepartureRepo (interface + InMemory + Postgres pair, wired as an optional
// AppDeps field). The pooled seat counter uses the same oversell-safe idiom as
// the shared-departure hold: a live-member seat sum guarded against `capacity`.
// ============================================================================

export interface CreateListArgs {
  corridorId: string;
  fromPlace: string;
  toPlace: string;
  date: string;
  slot: Slot;
  minSeats: number;
  capacity: number;
  seatPrice: number; // minor units
  note: string | null;
  cutoffAt: Date;
  createdBy: string | null;
  initialStatus?: RideListStatus;
}

export interface AddMemberArgs {
  sub: string;
  firstName: string;
  country: string;
  email: string;
  photoUrl?: string | null;
  preferredTime?: string | null;
  seats: number;
  preapprovalRef?: string | null;
}

export interface RideListWithMembers {
  list: RideList;
  members: RideMember[];
}

export interface RidePreapproval {
  list: RideList;
  member: RideMember;
}

export interface ListFilter {
  from?: string; // place name (case-insensitive)
  to?: string; // place name (case-insensitive); combines with `from` to narrow to one corridor
  when?: 'week' | 'fortnight' | 'all';
}

export interface RideListRepo {
  createList(args: CreateListArgs, now?: Date): Promise<RideList>;
  getByCode(code: string): Promise<RideListWithMembers | null>;
  getById(id: string): Promise<RideListWithMembers | null>;
  // Open ("gathering") lists, newest first, optionally filtered by from-city / date window.
  listOpen(filter?: ListFilter, now?: Date): Promise<RideListWithMembers[]>;
  // Dedupe support: an open list already covering this exact hop (and date, if given).
  findOpenByRoute(fromPlace: string, toPlace: string, date?: string): Promise<RideList | null>;
  // "My rides": lists where this traveller is a live member (held/charged), newest first.
  listForMember(sub: string): Promise<RideListWithMembers[]>;
  // Atomically add (or re-activate) a member. Returns null if the van is full; returns the
  // existing member if they're already live on the list (idempotent join).
  addMember(listId: string, args: AddMemberArgs, now?: Date): Promise<RideMember | null>;
  beginMemberPreapproval(
    listId: string,
    args: AddMemberArgs,
    orderId: string,
    expiresAt: Date,
    now?: Date,
  ): Promise<RideMember | null>;
  getByPreapprovalOrder(orderId: string): Promise<RidePreapproval | null>;
  approveMemberPreapproval(orderId: string, ref: string, now?: Date): Promise<RideListWithMembers | null>;
  failMemberPreapproval(orderId: string, now?: Date): Promise<void>;
  // Scratch a name off (soft — status → scratched). Returns true if a live member was removed.
  removeMember(listId: string, sub: string): Promise<boolean>;
  setStatus(id: string, status: RideListStatus): Promise<void>;
  lockDeparture(id: string, time: string): Promise<void>;
  setMemberStatus(listId: string, sub: string, status: MemberStatus): Promise<void>;
  // Gathering lists whose cutoff has passed (for the scheduler sweep).
  dueForCutoff(now: Date): Promise<RideListWithMembers[]>;
}

const DAY_MS = 86_400_000;
const norm = (s: string) => s.trim().toLowerCase();

export class InMemoryRideListRepo implements RideListRepo {
  private lists = new Map<string, RideList>();
  private members = new Map<string, RideMember[]>(); // listId → members

  private clone(id: string): RideListWithMembers | null {
    const list = this.lists.get(id);
    if (!list) return null;
    return { list: { ...list }, members: (this.members.get(id) ?? []).map((m) => ({ ...m })) };
  }

  async createList(args: CreateListArgs, now: Date = new Date()): Promise<RideList> {
    const id = randomUUID();
    // 4-digit public suffix derived from the uuid (stable, no RNG), retried on collision.
    let suffix = (parseInt(id.replace(/[^0-9]/g, '').slice(0, 6) || '0', 10) % 9000) + 1000;
    let code = makeCode(args.fromPlace, args.toPlace, String(suffix));
    while ([...this.lists.values()].some((l) => l.code === code)) {
      suffix = (suffix % 9000) + 1000 + 1;
      code = makeCode(args.fromPlace, args.toPlace, String(suffix));
    }
    const list: RideList = {
      id,
      code,
      corridorId: args.corridorId,
      fromPlace: args.fromPlace,
      toPlace: args.toPlace,
      date: args.date,
      slot: args.slot,
      lockedTime: null,
      minSeats: args.minSeats,
      capacity: args.capacity,
      seatPrice: args.seatPrice,
      status: args.initialStatus ?? 'gathering',
      note: args.note,
      cutoffAt: args.cutoffAt,
      createdBy: args.createdBy,
      createdAt: now,
      updatedAt: now,
    };
    this.lists.set(id, list);
    this.members.set(id, []);
    return { ...list };
  }

  async getByCode(code: string): Promise<RideListWithMembers | null> {
    const list = [...this.lists.values()].find((l) => l.code === code);
    return list ? this.clone(list.id) : null;
  }

  async getById(id: string): Promise<RideListWithMembers | null> {
    return this.clone(id);
  }

  async listOpen(filter: ListFilter = {}, now: Date = new Date()): Promise<RideListWithMembers[]> {
    const from = filter.from ? norm(filter.from) : null;
    const to = filter.to ? norm(filter.to) : null;
    const horizon = filter.when === 'week' ? 7 : filter.when === 'fortnight' ? 14 : null;
    return [...this.lists.values()]
      // A confirmed van stays on the board: it is proof the mechanism works, it may still have
      // seats, and when it is full it is the prompt to start another van on the same route.
      // Only cancelled/expired lists drop off — there is nothing left to join or copy.
      .filter((l) => l.status === 'gathering' || l.status === 'confirmed')
      .filter((l) => (from ? norm(l.fromPlace) === from : true))
      .filter((l) => (to ? norm(l.toPlace) === to : true))
      .filter((l) => {
        if (!horizon) return true;
        const days = (new Date(`${l.date}T00:00:00Z`).getTime() - now.getTime()) / DAY_MS;
        return days <= horizon;
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((l) => this.clone(l.id)!);
  }

  async findOpenByRoute(fromPlace: string, toPlace: string, date?: string): Promise<RideList | null> {
    const f = norm(fromPlace), t = norm(toPlace);
    const hit = [...this.lists.values()].find(
      (l) =>
        l.status === 'gathering' &&
        norm(l.fromPlace) === f &&
        norm(l.toPlace) === t &&
        (date ? l.date === date : true),
    );
    return hit ? { ...hit } : null;
  }

  async listForMember(sub: string): Promise<RideListWithMembers[]> {
    return [...this.lists.values()]
      .filter((l) => (this.members.get(l.id) ?? []).some((m) => m.sub === sub && countsForSeat(m)))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .map((l) => this.clone(l.id)!);
  }

  async addMember(listId: string, args: AddMemberArgs, now: Date = new Date()): Promise<RideMember | null> {
    const list = this.lists.get(listId);
    if (!list) return null;
    const members = this.members.get(listId) ?? [];

    const existing = members.find((m) => m.sub === args.sub);

    // Capacity guard — the pooled equivalent of holdSeats' oversell check. Seats this
    // traveller already holds don't count against them, or a 1→2 change on a van with
    // room would be refused. Mirrors the guarded insert in the Postgres repo.
    const others = committedSeats(members.filter((m) => m.sub !== args.sub));
    if (others + args.seats > list.capacity) return null;

    if (existing) {
      // Re-adding a live member is a seat change, and re-adding a scratched one puts them
      // back — either way they keep their original position in the line. A member who has
      // already been CHARGED keeps that status: 'held' would erase the record that their
      // money was taken. Mirrors the guarded ON CONFLICT in the Postgres repo.
      if (existing.status !== 'charged') existing.status = 'held';
      existing.seats = args.seats;
      existing.preferredTime = args.preferredTime ?? existing.preferredTime;
      existing.preapprovalRef = args.preapprovalRef ?? existing.preapprovalRef;
      existing.joinedAt = now;
      list.updatedAt = now;
      return { ...existing };
    }

    const position = members.reduce((max, m) => Math.max(max, m.position), 0) + 1;
    const member: RideMember = {
      id: randomUUID(),
      listId,
      position,
      sub: args.sub,
      firstName: args.firstName,
      country: args.country,
      email: args.email,
      photoUrl: args.photoUrl ?? null,
      preferredTime: args.preferredTime ?? null,
      seats: args.seats,
      preapprovalRef: args.preapprovalRef ?? null,
      preapprovalOrderId: null,
      preapprovalExpiresAt: null,
      status: 'held',
      joinedAt: now,
    };
    members.push(member);
    this.members.set(listId, members);
    list.updatedAt = now;
    return { ...member };
  }

  async beginMemberPreapproval(
    listId: string,
    args: AddMemberArgs,
    orderId: string,
    expiresAt: Date,
    now: Date = new Date(),
  ): Promise<RideMember | null> {
    const list = this.lists.get(listId);
    if (!list) return null;
    const members = this.members.get(listId) ?? [];
    const existing = members.find((m) => m.sub === args.sub);
    const reservedByOthers = members
      .filter((m) => m.sub !== args.sub)
      .filter((m) => countsForSeat(m) || (m.status === 'preapproval_pending' && (m.preapprovalExpiresAt?.getTime() ?? 0) > now.getTime()))
      .reduce((total, m) => total + m.seats, 0);
    if (reservedByOthers + args.seats > list.capacity) return null;
    if (existing) {
      existing.firstName = args.firstName;
      existing.country = args.country;
      existing.email = args.email;
      existing.photoUrl = args.photoUrl ?? null;
      existing.preferredTime = args.preferredTime ?? existing.preferredTime;
      existing.seats = args.seats;
      existing.preapprovalOrderId = orderId;
      existing.preapprovalExpiresAt = expiresAt;
      existing.status = 'preapproval_pending';
      existing.joinedAt = now;
      return { ...existing };
    }
    const position = members.reduce((max, m) => Math.max(max, m.position), 0) + 1;
    const member: RideMember = {
      id: randomUUID(), listId, position, sub: args.sub, firstName: args.firstName,
      country: args.country, email: args.email, photoUrl: args.photoUrl ?? null,
      preferredTime: args.preferredTime ?? null, seats: args.seats, preapprovalRef: null,
      preapprovalOrderId: orderId, preapprovalExpiresAt: expiresAt,
      status: 'preapproval_pending', joinedAt: now,
    };
    members.push(member);
    this.members.set(listId, members);
    list.updatedAt = now;
    return { ...member };
  }

  async getByPreapprovalOrder(orderId: string): Promise<RidePreapproval | null> {
    for (const [listId, members] of this.members) {
      const member = members.find((m) => m.preapprovalOrderId === orderId);
      const list = this.lists.get(listId);
      if (member && list) return { list: { ...list }, member: { ...member } };
    }
    return null;
  }

  async approveMemberPreapproval(
    orderId: string,
    ref: string,
    now: Date = new Date(),
  ): Promise<RideListWithMembers | null> {
    const found = await this.getByPreapprovalOrder(orderId);
    if (!found) return null;
    const list = this.lists.get(found.list.id)!;
    const members = this.members.get(list.id) ?? [];
    const member = members.find((m) => m.preapprovalOrderId === orderId)!;
    if (member.status === 'held' || member.status === 'charged') {
      if (list.status === 'pending_payment') list.status = 'gathering';
      return this.clone(list.id);
    }
    const liveOtherSeats = committedSeats(members.filter((m) => m.sub !== member.sub));
    if (
      member.status !== 'preapproval_pending' ||
      (member.preapprovalExpiresAt?.getTime() ?? 0) <= now.getTime() ||
      liveOtherSeats + member.seats > list.capacity
    ) {
      member.status = 'preapproval_failed';
      if (list.status === 'pending_payment') list.status = 'cancelled';
      return this.clone(list.id);
    }
    member.preapprovalRef = ref;
    member.status = 'held';
    member.preapprovalExpiresAt = null;
    if (list.status === 'pending_payment') list.status = 'gathering';
    list.updatedAt = now;
    return this.clone(list.id);
  }

  async failMemberPreapproval(orderId: string, now: Date = new Date()): Promise<void> {
    const found = await this.getByPreapprovalOrder(orderId);
    if (!found) return;
    const list = this.lists.get(found.list.id)!;
    const member = (this.members.get(list.id) ?? []).find((m) => m.preapprovalOrderId === orderId);
    if (member?.status === 'preapproval_pending') member.status = 'preapproval_failed';
    if (list.status === 'pending_payment') list.status = 'cancelled';
    list.updatedAt = now;
  }

  async removeMember(listId: string, sub: string): Promise<boolean> {
    const members = this.members.get(listId) ?? [];
    const m = members.find((x) => x.sub === sub && countsForSeat(x));
    if (!m) return false;
    m.status = 'scratched';
    const list = this.lists.get(listId);
    if (list) list.updatedAt = new Date();
    return true;
  }

  async setStatus(id: string, status: RideListStatus): Promise<void> {
    const list = this.lists.get(id);
    if (list) {
      list.status = status;
      list.updatedAt = new Date();
    }
  }

  async lockDeparture(id: string, time: string): Promise<void> {
    const list = this.lists.get(id);
    if (list) {
      list.lockedTime = time;
      list.updatedAt = new Date();
    }
  }

  async setMemberStatus(listId: string, sub: string, status: MemberStatus): Promise<void> {
    const m = (this.members.get(listId) ?? []).find((x) => x.sub === sub);
    if (m) m.status = status;
  }

  async dueForCutoff(now: Date): Promise<RideListWithMembers[]> {
    return [...this.lists.values()]
      .filter((l) => l.status === 'gathering' && l.cutoffAt.getTime() <= now.getTime())
      .map((l) => this.clone(l.id)!);
  }
}
