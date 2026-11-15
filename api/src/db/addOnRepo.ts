// Add-ons after booking (spec docs/superpowers/specs/2026-11-14-post-booking-add-ons-design.md §5).
// A REQUEST is what ops sends the customer: one or more LINES, each one rate-card add-on on one
// stored leg, at a price frozen when it was sent. One request is one payment. The original sale
// (bookings.total and its pricing snapshot) is never rewritten by anything here.
import { randomUUID } from 'node:crypto';
import type { AddOnRequestStatus } from '../domain/addOns';
import { deriveLegsForMode } from '../domain/bookingLegs';
import type { BookingRepo } from './bookingRepo';
import type { PaymentRepo } from './paymentRepo';

/** One `booking_legs` row. `id` is the only stable name a leg has: `seq` is display order. */
export interface StoredLeg {
  id: string;
  seq: number;
  kind: string;
  from: string;
  to: string;
  viaStops: string[];
  travelDate: string | null;
}

export interface AddOnLine {
  id: string;
  requestId: string;
  bookingId: string;
  legId: string;
  code: string;
  label: string;
  amountCents: number;
}

export interface AddOnRequest {
  id: string;
  bookingId: string;
  seq: number;
  status: AddOnRequestStatus;
  totalCents: number;
  currency: string;
  rateCardVersion: string;
  paymentId: string | null;
  createdBy: string;
  createdAt: Date;
  paidAt: Date | null;
  cancelledBy: string | null;
  cancelledAt: Date | null;
  cancelReason: string | null;
  /** In leg order, then by code. */
  lines: AddOnLine[];
}

export class AddOnError extends Error {
  constructor(
    public readonly code:
      | 'booking_not_found'
      | 'request_not_found'
      | 'duplicate_add_on'
      | 'already_paid'
      | 'not_open'
      | 'payment_in_flight',
  ) {
    super(code);
    this.name = 'AddOnError';
  }
}

export interface AddOnRepo {
  /** Stored, not-removed legs in seq order. */
  listLegs(bookingId: string): Promise<StoredLeg[]>;
  /** Assigns seq under the booking row lock and refuses a duplicate (same code on the same leg in
   *  a request that is `open`, or `paid` and not in `fullyRefundedPaymentIds`). */
  createRequest(input: {
    bookingId: string;
    lines: Array<{ legId: string; code: string; label: string; amountCents: number }>;
    currency: string;
    rateCardVersion: string;
    createdBy: string;
    now: Date;
    fullyRefundedPaymentIds: string[];
  }): Promise<AddOnRequest>;
  get(requestId: string): Promise<AddOnRequest | null>;
  /** Seq order, with lines. */
  listByBooking(bookingId: string): Promise<AddOnRequest[]>;
  /** One read for a set of bookings. Every id asked for is a key; one with no requests maps to []. */
  listByBookingIds(bookingIds: string[]): Promise<Map<string, AddOnRequest[]>>;
  /** Refuses `already_paid`, `not_open`, and `payment_in_flight` (its payment row is `pending`
   *  and `lastAttemptAt` is after `inFlightAfter`). */
  cancel(requestId: string, input: { by: string; reason: string; now: Date; inFlightAfter: Date }): Promise<AddOnRequest>;
  /** Sets payment_id once; a second call with the same id is a no-op. */
  attachPayment(requestId: string, paymentId: string): Promise<void>;
}

// The helpers below are shared so the two repos cannot disagree about a request's status, a
// duplicate, or the order of its lines.

// A request still holds its lines while it awaits payment, or is paid and not fully refunded.
export function addOnRequestStands(
  r: { status: string; paymentId: string | null },
  fullyRefundedPaymentIds: string[],
): boolean {
  if (r.status === 'open') return true;
  return r.status === 'paid' && !(r.paymentId && fullyRefundedPaymentIds.includes(r.paymentId));
}

// Why a request's own status rules out cancelling it, or null. A paid one is refunded instead.
export function addOnCancelRefusal(status: string): 'already_paid' | 'not_open' | null {
  if (status === 'paid') return 'already_paid';
  return status === 'open' ? null : 'not_open';
}

// The same code on the same leg, twice in one request or against a request that still stands.
export function hasDuplicateAddOn(
  lines: Array<{ legId: string; code: string }>,
  standing: Array<{ legId: string; code: string }>,
): boolean {
  const seen = new Set(standing.map((l) => `${l.legId}|${l.code}`));
  for (const line of lines) {
    const key = `${line.legId}|${line.code}`;
    if (seen.has(key)) return true;
    seen.add(key);
  }
  return false;
}

// The order a request's lines are read in: by the leg's place in the trip, then by code. Compared
// here rather than in SQL so both repos sort codes the same way whatever the database's collation.
export function compareAddOnLines(
  a: { legSeq: number; code: string },
  b: { legSeq: number; code: string },
): number {
  return a.legSeq - b.legSeq || (a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
}

export class InMemoryAddOnRepo implements AddOnRepo {
  private readonly rows = new Map<string, AddOnRequest>();
  // `${bookingId}:${seq}` → the leg's id, kept for the life of this instance (see listLegs).
  private readonly legIds = new Map<string, string>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bookings: BookingRepo,
    private readonly payments: PaymentRepo,
  ) {}

  // The in-memory booking repo stores no legs, so they are derived from the booking with the same
  // function the Postgres writers use: the two repos cannot disagree about which legs a booking
  // has. Dates are re-derived on every read, so a schedule change moves the leg's date here too.
  // The ids are this fake's own and exist only so tests have a stable key; the real ids are
  // `booking_legs.id`.
  // It cannot represent a removed leg, because nothing in the codebase removes one.
  async listLegs(bookingId: string): Promise<StoredLeg[]> {
    const b = await this.bookings.get(bookingId);
    if (!b) return [];
    const derived =
      deriveLegsForMode(b.mode, {
        single: b.mode === 'single' ? b.input : undefined,
        trip: b.mode === 'trip' ? b.input : undefined,
      }) ?? [];
    return derived.map((leg) => {
      const key = `${bookingId}:${leg.seq}`;
      let id = this.legIds.get(key);
      if (!id) {
        id = randomUUID();
        this.legIds.set(key, id);
      }
      return {
        id,
        seq: leg.seq,
        kind: leg.kind,
        from: leg.fromPlace,
        to: leg.toPlace,
        viaStops: [...leg.viaStops],
        travelDate: leg.travelDate,
      };
    });
  }

  createRequest(input: {
    bookingId: string;
    lines: Array<{ legId: string; code: string; label: string; amountCents: number }>;
    currency: string;
    rateCardVersion: string;
    createdBy: string;
    now: Date;
    fullyRefundedPaymentIds: string[];
  }): Promise<AddOnRequest> {
    // `exclusive` stands in for the booking row lock: two staff sending the same line arrive here
    // one after the other, and the second finds the first's request standing.
    return this.exclusive(async () => {
      if (!(await this.bookings.get(input.bookingId))) throw new AddOnError('booking_not_found');
      const existing = [...this.rows.values()].filter((r) => r.bookingId === input.bookingId);
      const standing = existing
        .filter((r) => addOnRequestStands(r, input.fullyRefundedPaymentIds))
        .flatMap((r) => r.lines);
      if (hasDuplicateAddOn(input.lines, standing)) throw new AddOnError('duplicate_add_on');
      const id = randomUUID();
      const legSeq = new Map((await this.listLegs(input.bookingId)).map((leg) => [leg.id, leg.seq]));
      const order = (line: { legId: string; code: string }) => ({
        legSeq: legSeq.get(line.legId) ?? Number.MAX_SAFE_INTEGER,
        code: line.code,
      });
      const lines: AddOnLine[] = input.lines
        .map((line) => ({ id: randomUUID(), requestId: id, bookingId: input.bookingId, ...line }))
        .sort((a, b) => compareAddOnLines(order(a), order(b)));
      const row: AddOnRequest = {
        id,
        bookingId: input.bookingId,
        seq: existing.reduce((max, r) => Math.max(max, r.seq), 0) + 1,
        status: 'open',
        totalCents: lines.reduce((sum, line) => sum + line.amountCents, 0),
        currency: input.currency,
        rateCardVersion: input.rateCardVersion,
        paymentId: null,
        createdBy: input.createdBy,
        createdAt: new Date(input.now),
        paidAt: null,
        cancelledBy: null,
        cancelledAt: null,
        cancelReason: null,
        lines,
      };
      this.rows.set(row.id, row);
      return structuredClone(row);
    });
  }

  async get(requestId: string): Promise<AddOnRequest | null> {
    const row = this.rows.get(requestId);
    return row ? structuredClone(row) : null;
  }

  async listByBooking(bookingId: string): Promise<AddOnRequest[]> {
    return [...this.rows.values()]
      .filter((r) => r.bookingId === bookingId)
      .sort((a, b) => a.seq - b.seq)
      .map((r) => structuredClone(r));
  }

  async listByBookingIds(bookingIds: string[]): Promise<Map<string, AddOnRequest[]>> {
    const out = new Map<string, AddOnRequest[]>();
    for (const bookingId of bookingIds) out.set(bookingId, await this.listByBooking(bookingId));
    return out;
  }

  cancel(
    requestId: string,
    input: { by: string; reason: string; now: Date; inFlightAfter: Date },
  ): Promise<AddOnRequest> {
    return this.exclusive(async () => {
      const row = this.rows.get(requestId);
      if (!row) throw new AddOnError('request_not_found');
      const refusal = addOnCancelRefusal(row.status);
      if (refusal) throw new AddOnError(refusal);
      // A PayHere form cannot be recalled once open, and an abandoned one may never report a
      // failure, so the lock is time-bound: only an attempt after `inFlightAfter` holds it.
      const payment = row.paymentId
        ? (await this.payments.findByBookingId(row.bookingId)).find((p) => p.id === row.paymentId)
        : undefined;
      if (payment?.status === 'pending' && payment.lastAttemptAt && payment.lastAttemptAt > input.inFlightAfter) {
        throw new AddOnError('payment_in_flight');
      }
      const cancelled: AddOnRequest = {
        ...row,
        status: 'cancelled',
        cancelledBy: input.by,
        cancelledAt: new Date(input.now),
        cancelReason: input.reason,
      };
      this.rows.set(row.id, cancelled);
      return structuredClone(cancelled);
    });
  }

  attachPayment(requestId: string, paymentId: string): Promise<void> {
    return this.exclusive(async () => {
      const row = this.rows.get(requestId);
      if (!row) throw new AddOnError('request_not_found');
      if (row.paymentId === paymentId) return;
      // One request is one payment, keyed on the request, so a different id here is a bug upstream.
      if (row.paymentId) throw new Error(`add_on_request_has_another_payment: ${requestId}`);
      this.rows.set(row.id, { ...row, paymentId });
    });
  }

  /** The request's payment landed. Settlement's write, exposed for the in-memory settlement repo
   *  the way InMemoryPaymentRepo.putForSettlement is; not part of AddOnRepo. */
  markPaidForSettlement(requestId: string, paidAt: Date): void {
    const row = this.rows.get(requestId);
    if (!row) throw new AddOnError('request_not_found');
    this.rows.set(row.id, { ...row, status: 'paid', paidAt: new Date(paidAt) });
  }

  private async exclusive<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release = () => {};
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await work();
    } finally {
      release();
    }
  }
}
