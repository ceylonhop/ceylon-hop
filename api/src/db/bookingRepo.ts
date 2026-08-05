import { randomUUID } from 'node:crypto';
import type { SingleTransferInput, BillingInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { SharedInput } from '../domain/shared';
import { assertTransition, type BookingStatus } from '../domain/status';

/**
 * Groups bookings belonging to one human. MUST match the `person_key` generated column on
 * customers (migration 0032, `lower(btrim(email))`) — the SQL repo reads the DB's value and
 * the in-memory repo computes it here, so this is the one definition both agree on.
 *
 * Note what this deliberately is NOT: a merge. Every booking keeps its own customers row,
 * because that row is the traveller snapshot for that booking — reusing one row across
 * bookings would rewrite the name on the older ones.
 */
export function personKeyFor(email: string): string {
  return email.trim().toLowerCase();
}

// M12 Slice 2 — where the booking came from. Only 'website' is written today; a future
// payment-link tool will write 'whatsapp'.
export type BookingChannel = 'website' | 'whatsapp';

// A booking is a single transfer, a multi-stop trip, or a shared seat — discriminated on
// `mode`. `input.customer` is common to all three shapes. `amountDueNow` is what
// checkout collects immediately; customer bookings currently pay the full total.
// `needsPricing`: the engine could not price this booking (unresolvable route, or Google was
// down and we refused to charge off a crow-flies estimate), so `total` is only a placeholder
// and checkout must refuse it until ops sets a real price. Present on every mode.
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
      needsPricing?: boolean;
      billing?: BillingInput;
      termsAcceptedAt?: Date;
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
      needsPricing?: boolean;
      billing?: BillingInput;
      termsAcceptedAt?: Date;
    }
  | {
      mode: 'shared';
      input: SharedInput;
      total: number;
      amountDueNow: number;
      currency: string;
      channel?: BookingChannel;
      needsPricing?: boolean;
      billing?: BillingInput;
      termsAcceptedAt?: Date;
    };

// Omit that distributes over the NewBooking union, so each variant keeps its own fields.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export type Booking = DistributiveOmit<NewBooking, 'amountDueNow' | 'channel' | 'needsPricing' | 'billing' | 'termsAcceptedAt'> & {
  // Billing details for the card (2026-08-01). Absent on website bookings and on every row
  // predating the pay page — the checkout adapter then OMITS the fields so PayHere collects
  // them itself, rather than sending the placeholder it used to.
  billing?: BillingInput | null;
  // When they accepted the terms + cancellation policy. Null on website bookings and every
  // row predating this — absence means "never recorded", never "declined".
  termsAcceptedAt?: string | null;
  id: string;
  reference: string;
  status: BookingStatus;
  createdAt: string;
  // Null/absent on rows created before GL-3 — checkout falls back to charging the total.
  amountDueNow?: number | null;
  channel: BookingChannel;
  // Null/absent on rows created before this existed — those are priced.
  needsPricing?: boolean | null;
  // Why this booking was cancelled and by whom (owner rule 2026-08-02). Only a cancelled
  // booking has them, and cancellations predating the rule have none.
  cancellationReason?: string | null;
  cancelledBy?: string | null;
  cancelledAt?: string | null;
};

/** Who reversed a booking and why. Written only on a cancellation. */
export interface StatusAudit {
  reason: string;
  by: string;
  at?: Date;
}

export interface BookingPricingSnapshot {
  version: 1;
  quoteId: string;
  quoteRevision: number;
  intentFingerprint: string;
  subtotalCents: number;
  discountTotalCents: number;
  totalCents: number;
  amountDueNowCents: number;
  currency: string;
  rateCardVersion: string;
  lineItems: unknown[];
}

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
  // `audit` records WHY, for the transitions where that matters. Optional so the many
  // non-cancelling callers are untouched; the cancel route always supplies it.
  setStatus(id: string, to: BookingStatus, audit?: StatusAudit): Promise<Booking>;
  list(filter?: { status?: BookingStatus | BookingStatus[] }): Promise<Booking[]>;
  // Re-record who is paying, for a booking that has not been paid yet.
  //
  // Every identity field we hand PayHere — name, email, phone, billing address — is read from
  // the booking row, never from the request that opened the payment. So a payer who mistyped
  // their address, was declined, and corrected it was still charged against the old details:
  // the correction was validated and dropped. Since that data feeds the issuer's 3DS risk
  // decision, the retry was arguably less likely to succeed than the first attempt.
  //
  // Implementations MUST make the not-yet-paid check part of the write itself, so a settlement
  // landing concurrently cannot have its payer overwritten. Returns the booking unchanged when
  // it is no longer chargeable.
  // `termsAcceptedAt` is optional: an ops "Mark booked" re-book carries no acceptance, because
  // nobody ticked a box — that customer agreed over WhatsApp. Absent leaves the column alone
  // rather than stamping an acceptance that never happened.
  refreshPayerDetails(
    id: string,
    details: { customer: SingleTransferInput['customer']; billing?: BillingInput; termsAcceptedAt?: Date },
  ): Promise<Booking>;
}

// A booking's payer may only be rewritten while it is still awaiting money.
export const PAYER_EDITABLE_STATUSES = ['draft', 'payment_pending'] as const;

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
  private pricingSnapshots = new Map<string, BookingPricingSnapshot>();

  async create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking> {
    const key = opts?.idempotencyKey;
    if (key) {
      // Synchronous check (no await before the insert below) so two concurrent create()
      // calls with the same key can't both pass the guard and duplicate the booking —
      // mirrors the DB's unique idempotency_key constraint.
      const existingId = this.byKey.get(key);
      // `byId` is append-only (no eviction anywhere in this repo), so a live byKey entry
      // always resolves to a row — the non-null assertion holds.
      if (existingId) return this.byId.get(existingId)!;
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
      billing: b.billing ?? null, // normalise absent → null, as the SQL repo does
      termsAcceptedAt: b.termsAcceptedAt ? b.termsAcceptedAt.toISOString() : null,
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

  async setStatus(id: string, to: BookingStatus, audit?: StatusAudit): Promise<Booking> {
    const current = this.byId.get(id);
    if (!current) throw new BookingNotFoundError(id);
    assertTransition(current.status, to); // throws on illegal; leaves the row unchanged
    const updated: Booking = {
      ...current,
      status: to,
      ...(to === 'cancelled' && audit
        ? { cancellationReason: audit.reason, cancelledBy: audit.by, cancelledAt: (audit.at ?? new Date()).toISOString() }
        : {}),
    };
    this.byId.set(id, updated);
    return updated;
  }

  async refreshPayerDetails(
    id: string,
    details: { customer: SingleTransferInput['customer']; billing?: BillingInput; termsAcceptedAt?: Date },
  ): Promise<Booking> {
    const current = this.byId.get(id);
    if (!current) throw new BookingNotFoundError(id);
    if (!(PAYER_EDITABLE_STATUSES as readonly string[]).includes(current.status)) return current;
    const updated: Booking = {
      ...current,
      input: { ...current.input, customer: { ...details.customer } },
      // Absent billing leaves what was captured before: a payer who filled the address on the
      // first attempt and left it blank on a retry should not lose it.
      billing: details.billing ? { ...details.billing } : current.billing,
      // The acceptance belongs to whoever is actually paying. /start requires termsAccepted:true
      // on EVERY call, so a resuming payer has just agreed — recording the earlier submitter's
      // timestamp would leave a refund dispute holding evidence about the wrong person.
      termsAcceptedAt: details.termsAcceptedAt ? details.termsAcceptedAt.toISOString() : current.termsAcceptedAt,
    } as Booking;
    this.byId.set(id, updated);
    return updated;
  }

  async list(filter?: { status?: BookingStatus | BookingStatus[] }): Promise<Booking[]> {
    const all = [...this.byId.values()];
    if (!filter?.status) return all;
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    return all.filter((b) => statuses.includes(b.status));
  }

  snapshotForSettlement(): Map<string, Booking> {
    return new Map([...this.byId].map(([id, booking]) => [id, structuredClone(booking)]));
  }

  restoreForSettlement(snapshot: Map<string, Booking>): void {
    this.byId = new Map([...snapshot].map(([id, booking]) => [id, structuredClone(booking)]));
  }

  snapshotForQuoteConversion(): {
    byId: Map<string, Booking>;
    refs: Set<string>;
    byKey: Map<string, string>;
    pricingSnapshots: Map<string, BookingPricingSnapshot>;
  } {
    return {
      byId: structuredClone(this.byId),
      refs: structuredClone(this.refs),
      byKey: structuredClone(this.byKey),
      pricingSnapshots: structuredClone(this.pricingSnapshots),
    };
  }

  restoreForQuoteConversion(snapshot: ReturnType<InMemoryBookingRepo['snapshotForQuoteConversion']>): void {
    this.byId = structuredClone(snapshot.byId);
    this.refs = structuredClone(snapshot.refs);
    this.byKey = structuredClone(snapshot.byKey);
    this.pricingSnapshots = structuredClone(snapshot.pricingSnapshots);
  }

  setPricingSnapshotForQuoteConversion(
    bookingId: string,
    snapshot: BookingPricingSnapshot,
  ): void {
    this.pricingSnapshots.set(bookingId, structuredClone(snapshot));
  }

  getPricingSnapshotForQuoteConversion(bookingId: string): BookingPricingSnapshot | null {
    const snapshot = this.pricingSnapshots.get(bookingId);
    return snapshot ? structuredClone(snapshot) : null;
  }
}
