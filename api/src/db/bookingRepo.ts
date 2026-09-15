import { randomUUID } from 'node:crypto';
import type { SingleTransferInput, BillingInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { SharedInput } from '../domain/shared';
import { assertTransition, type BookingStatus } from '../domain/status';
import type { PaymentRepo } from './paymentRepo';
import {
  PROMO_HOLD_MS,
  PromoCodeRefusedError,
  promoCodeAvailability,
  promoUseState,
  type PromoCode,
  type PromoUseState,
} from '../domain/promoCode';

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
      // Cents taken off by a promo code (spec 2026-09-14 §6.1). Absent on every other booking.
      discountTotal?: number;
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
      // Cents taken off by a promo code (spec 2026-09-14 §6.1). Absent on every other booking.
      discountTotal?: number;
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
  // Promo code (spec 2026-09-14 §5). Present only on bookings made with a code.
  promoCodeId?: string | null;
  promoHoldUntil?: string | null; // ISO
};

/** Who reversed a booking and why. Written only on a cancellation. */
export interface StatusAudit {
  reason: string;
  by: string;
  at?: Date;
}

/** A booking taking one use of a code (spec 2026-09-14 §5.3). */
export interface PromoHold {
  code: PromoCode;
  now: Date;
}

/** One booking that carried a code, for the founder's detail view (§6.5). */
export interface PromoBookingUse {
  bookingId: string;
  reference: string;
  status: BookingStatus;
  discountCents: number;
  createdAt: string;
  use: PromoUseState;
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
  // `promo` takes one use of a code inside the same write; throws PromoCodeRefusedError when the
  // code no longer works or every use is paid or held (spec 2026-09-14 §5.3).
  create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<Booking>;
  /** Paid and held uses of a code at `now` (§5.1). */
  promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }>;
  /** Every booking that carried the code, newest first (§6.5). */
  promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]>;
  /** §6.3 — refresh a valid hold, or re-take a lapsed one; throws PromoCodeRefusedError. */
  reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void>;
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
  private payments?: PaymentRepo;
  // Per-code queue standing in for Postgres's FOR UPDATE: the count and the insert are separated by
  // awaits, so without it two concurrent bookings could both see the last use as free.
  private promoLocks = new Map<string, Promise<void>>();

  /** Lets the count see succeeded payments exactly as the Postgres query does (§5.1). */
  attachPayments(payments: PaymentRepo): void {
    this.payments = payments;
  }

  private async withPromoLock<T>(codeId: string, fn: () => Promise<T>): Promise<T> {
    const previous = this.promoLocks.get(codeId) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.then(() => current);
    this.promoLocks.set(codeId, tail);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.promoLocks.get(codeId) === tail) this.promoLocks.delete(codeId);
    }
  }

  private async useOf(b: Booking, now: Date): Promise<PromoUseState> {
    const hasSucceededPayment = this.payments
      ? (await this.payments.findByBookingId(b.id)).some((p) => p.status === 'succeeded')
      : false;
    return promoUseState(
      { status: b.status, promoHoldUntil: b.promoHoldUntil ? new Date(b.promoHoldUntil) : null, hasSucceededPayment },
      now,
    );
  }

  async create(b: NewBooking, opts?: { idempotencyKey?: string; promo?: PromoHold }): Promise<Booking> {
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
    const promo = opts?.promo;
    if (!promo) return this.insert(b, key);
    return this.withPromoLock(promo.code.id, async () => {
      // Re-check under the lock: a concurrent retry with the same key may have inserted meanwhile.
      if (key) {
        const existingId = this.byKey.get(key);
        if (existingId) return this.byId.get(existingId)!;
      }
      const unavailable = promoCodeAvailability(promo.code, promo.now);
      if (unavailable) throw new PromoCodeRefusedError(unavailable);
      const { paid, held } = await this.promoUsage(promo.code.id, promo.now);
      if (paid + held >= promo.code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      return this.insert(b, key, {
        promoCodeId: promo.code.id,
        promoHoldUntil: new Date(promo.now.getTime() + PROMO_HOLD_MS).toISOString(),
      });
    });
  }

  private insert(b: NewBooking, key: string | undefined, promo?: { promoCodeId: string; promoHoldUntil: string }): Booking {
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
      ...(promo ?? {}),
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

  async promoUsage(codeId: string, now: Date): Promise<{ paid: number; held: number }> {
    let paid = 0;
    let held = 0;
    for (const b of [...this.byId.values()]) {
      if (b.promoCodeId !== codeId) continue;
      const use = await this.useOf(b, now);
      if (use === 'paid') paid++;
      else if (use === 'held') held++;
    }
    return { paid, held };
  }

  async promoBookings(codeId: string, now: Date): Promise<PromoBookingUse[]> {
    const carrying = [...this.byId.values()]
      .filter((b) => b.promoCodeId === codeId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(carrying.map(async (b) => ({
      bookingId: b.id,
      reference: b.reference,
      status: b.status,
      discountCents: b.mode === 'shared' ? 0 : b.discountTotal ?? 0,
      createdAt: b.createdAt,
      use: await this.useOf(b, now),
    })));
  }

  async reholdPromo(bookingId: string, code: PromoCode, now: Date): Promise<void> {
    if (!this.byId.has(bookingId)) throw new BookingNotFoundError(bookingId);
    await this.withPromoLock(code.id, async () => {
      const b = this.byId.get(bookingId)!;
      if (b.promoCodeId !== code.id) throw new Error('PROMO_CODE_MISMATCH');
      const holdValid = !!b.promoHoldUntil && new Date(b.promoHoldUntil).getTime() > now.getTime();
      if (!holdValid) {
        const unavailable = promoCodeAvailability(code, now);
        if (unavailable) throw new PromoCodeRefusedError(unavailable);
        const { paid, held } = await this.promoUsage(code.id, now); // this booking's lapsed hold is not counted
        if (paid + held >= code.maxUses) throw new PromoCodeRefusedError('promo_code_used_up');
      }
      this.byId.set(bookingId, { ...b, promoHoldUntil: new Date(now.getTime() + PROMO_HOLD_MS).toISOString() });
    });
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
