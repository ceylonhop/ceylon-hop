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

export interface ListFilter {
  from?: string; // place name (case-insensitive)
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
      status: 'gathering',
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
    const horizon = filter.when === 'week' ? 7 : filter.when === 'fortnight' ? 14 : null;
    return [...this.lists.values()]
      .filter((l) => l.status === 'gathering')
      .filter((l) => (from ? norm(l.fromPlace) === from : true))
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
    if (existing && countsForSeat(existing)) return { ...existing }; // already live → idempotent

    // Capacity guard — the pooled equivalent of holdSeats' oversell check.
    const committed = committedSeats(members);
    if (committed + args.seats > list.capacity) return null;

    if (existing) {
      // re-activate a scratched member, keeping their original position
      existing.status = 'held';
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
      status: 'held',
      joinedAt: now,
    };
    members.push(member);
    this.members.set(listId, members);
    list.updatedAt = now;
    return { ...member };
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
