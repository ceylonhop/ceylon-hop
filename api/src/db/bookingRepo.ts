import { randomUUID } from 'node:crypto';
import type { SingleTransferInput } from '../domain/singleTransfer';

export interface NewBooking {
  input: SingleTransferInput;
  total: number;
  currency: string;
}

export interface Booking extends NewBooking {
  id: string;
  reference: string;
  status: 'draft';
  createdAt: string;
}

// The storage seam. The route layer depends only on this interface, so swapping the
// in-memory store for Postgres later (M2) touches nothing else.
export interface BookingRepo {
  create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking>;
  get(id: string): Promise<Booking | null>;
  findByIdempotencyKey(key: string): Promise<Booking | null>;
}

// No ambiguous characters (no 0/O/1/I), so a reference is easy to read over the phone.
const REF_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function randomRef(): string {
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
    let reference = randomRef();
    while (this.refs.has(reference)) reference = randomRef();
    const booking: Booking = {
      ...b,
      id: randomUUID(),
      reference,
      status: 'draft',
      createdAt: new Date().toISOString(),
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
}
