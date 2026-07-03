import { randomUUID } from 'node:crypto';
import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { SharedInput } from '../domain/shared';
import { assertTransition, type BookingStatus } from '../domain/status';

// M12 Slice 2 — where the booking came from. Only 'website' is written today; a future
// payment-link tool will write 'whatsapp'.
export type BookingChannel = 'website' | 'whatsapp';

// A booking is a single transfer, a multi-stop trip, or a shared seat — discriminated on
// `mode`. `input.customer` is common to all three shapes. `amountDueNow` (GL-3) is what
// checkout collects immediately — the chauffeur deposit, or the full total.
export type NewBooking =
  | {
      mode: 'single';
      input: SingleTransferInput;
      total: number;
      amountDueNow: number;
      currency: string;
      // Road distance + driving duration from the maps adapter (M8). Null when unresolved.
      distanceKm?: number | null;
      durationMin?: number | null;
      channel?: BookingChannel;
    }
  | {
      mode: 'trip';
      input: TripInput;
      total: number;
      amountDueNow: number;
      currency: string;
      // Total road distance + driving duration summed across the trip's legs (M8).
      distanceKm?: number | null;
      durationMin?: number | null;
      channel?: BookingChannel;
    }
  | {
      mode: 'shared';
      input: SharedInput;
      total: number;
      amountDueNow: number;
      currency: string;
      channel?: BookingChannel;
    };

// Omit that distributes over the NewBooking union, so each variant keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Booking = DistributiveOmit<NewBooking, 'amountDueNow' | 'channel'> & {
  id: string;
  reference: string;
  status: BookingStatus;
  createdAt: string;
  // Null/absent on rows created before GL-3 — checkout falls back to charging the total.
  amountDueNow?: number | null;
  channel: BookingChannel;
};

// The storage seam. The route layer depends only on this interface, so swapping the
// in-memory store for Postgres later (M2) touches nothing else.
export class BookingNotFoundError extends Error {
  constructor(public readonly id: string) {
    super(`Booking not found: ${id}`);
    this.name = 'BookingNotFoundError';
  }
}

export interface BookingRepo {
  create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking>;
  get(id: string): Promise<Booking | null>;
  findByIdempotencyKey(key: string): Promise<Booking | null>;
  setStatus(id: string, to: BookingStatus): Promise<Booking>;
  list(filter?: { status?: BookingStatus }): Promise<Booking[]>;
}

// No ambiguous characters (no 0/O/1/I), so a reference is easy to read over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function generateReference(): string {
  let s = 'CH-';
  for (let i = 0; i < 5; i++) {
    s += REF_ALPHABET[Math.floor(Math.random() * REF_ALPHABET.length)];
  }
  return s;
}

export class InMemoryBookingRepo implements BookingRepo {
  private byId = new Map<string, Booking>();
  private refs = new Set<string>();
  private byKey = new Map<string, string>();

  async create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking> {
    const key = opts?.idempotencyKey;
    if (key) {
      const existing = await this.findByIdempotencyKey(key);
      if (existing) return existing;
    }
    let reference = generateReference();
    while (this.refs.has(reference)) reference = generateReference();
    const booking: Booking = {
      ...b,
      id: randomUUID(),
      reference,
      status: 'draft',
      createdAt: new Date().toISOString(),
      channel: b.channel ?? 'website',
    };
    this.byId.set(booking.id, booking);
    this.refs.add(reference);
    if (key) this.byKey.set(key, booking.id);
    return booking;
  }

  async get(id: string): Promise<Booking | null> {
    return this.byId.get(id) ?? null;
  }

  async findByIdempotencyKey(key: string): Promise<Booking | null> {
    const id = this.byKey.get(key);
    return id ? (this.byId.get(id) ?? null) : null;
  }

  async setStatus(id: string, to: BookingStatus): Promise<Booking> {
    const current = this.byId.get(id);
    if (!current) throw new BookingNotFoundError(id);
    assertTransition(current.status, to); // throws on illegal; leaves the row unchanged
    const updated: Booking = { ...current, status: to };
    this.byId.set(id, updated);
    return updated;
  }

  async list(filter?: { status?: BookingStatus }): Promise<Booking[]> {
    const all = [...this.byId.values()];
    return filter?.status ? all.filter((b) => b.status === filter.status) : all;
  }
}
