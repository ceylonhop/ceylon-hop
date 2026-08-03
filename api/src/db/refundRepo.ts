import { randomUUID } from 'node:crypto';
import type { BookingRepo } from './bookingRepo';
import type { PaymentRepo } from './paymentRepo';

export type RefundStatus =
  | 'manual_pending'
  | 'manual_confirmed'
  | 'cancelled'
  // Called, or about to be called, and the outcome is not yet known. See settleApi.
  | 'api_processing'
  | 'api_confirmed'
  | 'api_failed';

// Money is, or may be, spoken for. `api_failed` is deliberately absent: PayHere told us the
// refund did not happen, so it must not hold back the customer's remaining refundable balance.
// `api_processing` IS present — it may have moved, and pretending otherwise is how a customer
// gets refunded twice.
export const RESERVING_STATUSES: readonly RefundStatus[] = [
  'manual_pending',
  'manual_confirmed',
  'api_processing',
  'api_confirmed',
];

// Money has actually left. Drives "is this booking fully refunded".
export const REFUNDED_STATUSES: readonly RefundStatus[] = ['manual_confirmed', 'api_confirmed'];

export interface Refund {
  id: string;
  bookingId: string;
  paymentId: string;
  provider: string;
  amountCents: number;
  currency: string;
  status: RefundStatus;
  reason: string;
  gatewayRef: string | null;
  requestedBy: string;
  requestedAt: Date;
  confirmedBy: string | null;
  confirmedAt: Date | null;
  providerMessage: string | null;
  apiAttemptedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export class RefundError extends Error {
  constructor(
    public readonly code:
      | 'booking_not_found'
      | 'payment_not_captured'
      | 'currency_mismatch'
      | 'refund_exceeds_captured'
      | 'refund_not_found'
      | 'refund_already_confirmed'
      | 'refund_not_pending'
      | 'gateway_ref_required'
      | 'gateway_ref_conflict'
      | 'booking_state_conflict'
      | 'refund_not_processing'
      | 'payment_not_refundable_by_api',
  ) {
    super(code);
    this.name = 'RefundError';
  }
}

export interface RefundConfirmation {
  refund: Refund;
  bookingFullyRefunded: boolean;
}

// What `beginApi` hands back: the row now locked in api_processing, plus the gateway's own
// payment id, which is what the Refund API takes. Read here rather than by the caller so the
// lock and the id come from one transaction.
export interface RefundApiStart {
  refund: Refund;
  gatewayPaymentId: string;
  isFullRefund: boolean;
}

export type RefundApiOutcome =
  | { kind: 'succeeded'; gatewayRef: string; providerMessage?: string }
  | { kind: 'failed'; providerMessage: string };

export interface RefundRepo {
  request(input: {
    bookingId: string;
    amountCents: number;
    currency: string;
    reason: string;
    requestedBy: string;
  }): Promise<Refund>;
  confirm(input: {
    bookingId: string;
    refundId: string;
    gatewayRef: string;
    confirmedBy: string;
  }): Promise<RefundConfirmation>;
  cancel(input: { bookingId: string; refundId: string }): Promise<Refund>;
  list(bookingId: string): Promise<Refund[]>;
  // Claim a pending refund for an API call. Moves manual_pending -> api_processing and stamps
  // apiAttemptedAt, so a second concurrent click finds the row already claimed and stops.
  beginApi(input: { bookingId: string; refundId: string }): Promise<RefundApiStart>;
  // Record a DEFINITE outcome. There is deliberately no way to say "unknown": an indefinite
  // result means the caller leaves the row in api_processing and walks away.
  settleApi(input: {
    bookingId: string;
    refundId: string;
    outcome: RefundApiOutcome;
    confirmedBy: string;
  }): Promise<RefundConfirmation>;
  // Rows stuck mid-call, oldest first — the watchdog's input.
  listStuckApi(olderThan: Date): Promise<Refund[]>;
}

export class InMemoryRefundRepo implements RefundRepo {
  private readonly rows = new Map<string, Refund>();
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly bookings: BookingRepo,
    private readonly payments: PaymentRepo,
  ) {}

  request(input: {
    bookingId: string;
    amountCents: number;
    currency: string;
    reason: string;
    requestedBy: string;
  }): Promise<Refund> {
    return this.exclusive(async () => {
      if (!(await this.bookings.get(input.bookingId))) throw new RefundError('booking_not_found');
      const captured = (await this.payments.findByBookingId(input.bookingId)).filter(
        (payment) => payment.status === 'succeeded',
      );
      if (captured.length === 0) throw new RefundError('payment_not_captured');
      if (captured.some((payment) => payment.currency !== input.currency)) {
        throw new RefundError('currency_mismatch');
      }
      const capturedCents = captured.reduce((sum, payment) => sum + payment.amount, 0);
      const reserved = [...this.rows.values()]
        .filter(
          (refund) =>
            refund.bookingId === input.bookingId && RESERVING_STATUSES.includes(refund.status),
        )
        .reduce((sum, refund) => sum + refund.amountCents, 0);
      if (reserved + input.amountCents > capturedCents) {
        throw new RefundError('refund_exceeds_captured');
      }
      const now = new Date();
      const row: Refund = {
        id: randomUUID(),
        bookingId: input.bookingId,
        paymentId: captured[0].id,
        provider: captured[0].provider,
        amountCents: input.amountCents,
        currency: input.currency,
        status: 'manual_pending',
        reason: input.reason,
        gatewayRef: null,
        requestedBy: input.requestedBy,
        requestedAt: now,
        confirmedBy: null,
        confirmedAt: null,
        providerMessage: null,
        apiAttemptedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, row);
      return structuredClone(row);
    });
  }

  confirm(input: {
    bookingId: string;
    refundId: string;
    gatewayRef: string;
    confirmedBy: string;
  }): Promise<RefundConfirmation> {
    return this.exclusive(async () => {
      const row = this.rows.get(input.refundId);
      if (!row || row.bookingId !== input.bookingId) throw new RefundError('refund_not_found');
      if (REFUNDED_STATUSES.includes(row.status)) throw new RefundError('refund_already_confirmed');
      // api_processing is confirmable on purpose: a call whose outcome we never learned is
      // resolved by a human reading PayHere's dashboard and pasting the reference here.
      if (row.status !== 'manual_pending' && row.status !== 'api_processing') {
        throw new RefundError('refund_not_pending');
      }
      if (
        [...this.rows.values()].some(
          (refund) =>
            refund.provider === row.provider &&
            refund.gatewayRef === input.gatewayRef &&
            refund.id !== row.id,
        )
      ) {
        throw new RefundError('gateway_ref_conflict');
      }
      const now = new Date();
      const confirmed: Refund = {
        ...row,
        // How the money actually moved, not who typed the reference: a refund PayHere's API
        // performed stays api_confirmed even when a human supplied its number afterwards.
        status: row.status === 'api_processing' ? 'api_confirmed' : 'manual_confirmed',
        gatewayRef: input.gatewayRef,
        confirmedBy: input.confirmedBy,
        confirmedAt: now,
        updatedAt: now,
      };
      this.rows.set(row.id, confirmed);
      const captured = (await this.payments.findByBookingId(input.bookingId))
        .filter((payment) => payment.status === 'succeeded')
        .reduce((sum, payment) => sum + payment.amount, 0);
      const refunded = [...this.rows.values()]
        .filter(
          (refund) =>
            refund.bookingId === input.bookingId && REFUNDED_STATUSES.includes(refund.status),
        )
        .reduce((sum, refund) => sum + refund.amountCents, 0);
      if (refunded > captured) {
        this.rows.set(row.id, row);
        throw new RefundError('refund_exceeds_captured');
      }
      const fully = refunded === captured;
      if (fully) {
        try {
          await this.bookings.setStatus(input.bookingId, 'refunded');
        } catch {
          this.rows.set(row.id, row);
          throw new RefundError('booking_state_conflict');
        }
      }
      return { refund: structuredClone(confirmed), bookingFullyRefunded: fully };
    });
  }

  cancel(input: { bookingId: string; refundId: string }): Promise<Refund> {
    return this.exclusive(async () => {
      const row = this.rows.get(input.refundId);
      if (!row || row.bookingId !== input.bookingId) throw new RefundError('refund_not_found');
      if (REFUNDED_STATUSES.includes(row.status)) throw new RefundError('refund_already_confirmed');
      // Deliberately NOT cancellable from api_processing: cancelling would release the reserved
      // amount while PayHere may already have paid it out.
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const cancelled = { ...row, status: 'cancelled' as const, updatedAt: new Date() };
      this.rows.set(row.id, cancelled);
      return structuredClone(cancelled);
    });
  }

  // Claim the row BEFORE anyone calls PayHere. Two ops agents double-clicking arrive here
  // serialised by `exclusive`, and the second finds a row that is no longer manual_pending.
  beginApi(input: { bookingId: string; refundId: string }): Promise<RefundApiStart> {
    return this.exclusive(async () => {
      const row = this.rows.get(input.refundId);
      if (!row || row.bookingId !== input.bookingId) throw new RefundError('refund_not_found');
      if (REFUNDED_STATUSES.includes(row.status)) throw new RefundError('refund_already_confirmed');
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const payment = (await this.payments.findByBookingId(input.bookingId)).find(
        (candidate) => candidate.id === row.paymentId && candidate.status === 'succeeded',
      );
      if (!payment) throw new RefundError('payment_not_captured');
      // PayHere writes payment_id "0" on a failed payment, and nothing at all on a booking that
      // never settled. Either way there is no id to refund against, and sending one of those
      // would be asking PayHere to refund a payment that does not exist.
      // Null unless the money arrived through the gateway; "0" is what PayHere writes on a
      // FAILED payment. Either way there is nothing to refund against, and sending one of them
      // would ask PayHere to refund a payment that does not exist.
      const gatewayPaymentId = await this.payments.gatewayPaymentIdFor(payment.id);
      if (!gatewayPaymentId || gatewayPaymentId === '0') {
        throw new RefundError('payment_not_refundable_by_api');
      }
      const now = new Date();
      const claimed: Refund = { ...row, status: 'api_processing', apiAttemptedAt: now, updatedAt: now };
      this.rows.set(row.id, claimed);
      return {
        refund: structuredClone(claimed),
        gatewayPaymentId,
        isFullRefund: row.amountCents === payment.amount,
      };
    });
  }

  settleApi(input: {
    bookingId: string;
    refundId: string;
    outcome: RefundApiOutcome;
    confirmedBy: string;
  }): Promise<RefundConfirmation> {
    if (input.outcome.kind === 'failed') {
      return this.exclusive(async () => {
        const row = this.rows.get(input.refundId);
        if (!row || row.bookingId !== input.bookingId) throw new RefundError('refund_not_found');
        if (row.status !== 'api_processing') throw new RefundError('refund_not_processing');
        const failed: Refund = {
          ...row,
          status: 'api_failed',
          providerMessage: input.outcome.providerMessage ?? null,
          updatedAt: new Date(),
        };
        this.rows.set(row.id, failed);
        // api_failed reserves nothing, so the customer's refundable balance is whole again and
        // the agent can simply request another refund.
        return { refund: structuredClone(failed), bookingFullyRefunded: false };
      });
    }
    // Success reuses confirm() wholesale: same evidence rules, same fully-refunded arithmetic,
    // same booking transition. The API path must not grow a second opinion about any of that.
    const { gatewayRef, providerMessage } = input.outcome;
    return this.confirm({
      bookingId: input.bookingId,
      refundId: input.refundId,
      gatewayRef,
      confirmedBy: input.confirmedBy,
    }).then((outcome) => {
      const stored = this.rows.get(input.refundId);
      if (stored && providerMessage) {
        const withMessage = { ...stored, providerMessage };
        this.rows.set(stored.id, withMessage);
        return { ...outcome, refund: structuredClone(withMessage) };
      }
      return outcome;
    });
  }

  async listStuckApi(olderThan: Date): Promise<Refund[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'api_processing' && r.apiAttemptedAt !== null && r.apiAttemptedAt < olderThan)
      .sort((a, b) => (a.apiAttemptedAt?.getTime() ?? 0) - (b.apiAttemptedAt?.getTime() ?? 0))
      .map((r) => structuredClone(r));
  }

  async list(bookingId: string): Promise<Refund[]> {
    return [...this.rows.values()]
      .filter((refund) => refund.bookingId === bookingId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .map((refund) => structuredClone(refund));
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
