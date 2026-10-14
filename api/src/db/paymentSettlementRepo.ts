import type { VerifiedPaymentEvent } from '../adapters/payments';
import type { Booking } from './bookingRepo';
import { InMemoryBookingRepo } from './bookingRepo';
import { InMemoryPaymentEventRepo } from './paymentEventRepo';
import type { Payment } from './paymentRepo';
import { InMemoryPaymentRepo } from './paymentRepo';
import type { TrackingCorrelation } from '../domain/trackingContract';
import { SECURED_STATUSES } from '../domain/balance';

export type PaymentSettlementOutcome =
  | { kind: 'settled'; payment: Payment; booking: Booking }
  | { kind: 'duplicate'; payment: Payment; booking: Booking }
  | { kind: 'failed'; payment: Payment; booking: Booking }
  | { kind: 'reversal'; payment: Payment; booking: Booking }
  // A non-success notify for a DIFFERENT attempt on an order we already captured. PayHere lets one
  // order_id carry several attempts (confirmed by PayHere, 2026-09-25), so an earlier attempt's
  // decline can land after a later attempt was paid. The event is recorded as evidence; nothing
  // about the payment or booking changes, and it is not a reversal.
  | { kind: 'stale_attempt'; payment: Payment; booking: Booking }
  // A SECOND capture: some other payment on this booking had already settled when this one
  // arrived (a late PayHere notify on a booking ops settled in cash). The money is real and is
  // recorded — refundRepo sums succeeded payments, so dropping it would cap a refund below what
  // we actually hold — but the booking is deliberately left exactly as the first settlement left
  // it: a human has to decide which capture to give back. Distinct from unexpected_booking_state,
  // whose story ("captured with no paid-transition") is the wrong one to page an operator with.
  //
  // `firstCaptureTxnId` is set when the second capture is on the SAME order (PayHere does not
  // enforce order_id uniqueness): the payment row keeps that first capture's id — the one our
  // refund tool reaches — and the second exists only as a payment_events row.
  | { kind: 'double_capture'; payment: Payment; booking: Booking; firstCaptureTxnId?: string }
  // The balance of a deposit booking (spec 2026-10-07 §5.1): a second capture that is the other
  // half of ONE sale, not a second sale. The payment is settled; the booking is left exactly where
  // it is (already paid / confirmed / in progress) — the deposit is what secured it.
  | { kind: 'balance_settled'; payment: Payment; booking: Booking }
  | { kind: 'unexpected_booking_state'; payment: Payment; booking: Booking };

export interface PaymentSettlementRepo {
  acceptVerifiedEvent(event: VerifiedPaymentEvent, correlation?: TrackingCorrelation): Promise<PaymentSettlementOutcome>;
}

export type SettlementFailurePoint =
  | 'after_event_insert'
  | 'after_payment_update'
  | 'after_booking_update';

export type SettlementFailureHook = (point: SettlementFailurePoint) => Promise<void> | void;

/** The gateway id of the capture a payment row already records, or null when there is none we
 *  can compare against: an unsettled row, a manual settlement (its id is a slip reference, not a
 *  PayHere payment_id), or a legacy row settled before ids were stored. Shared by both repos so the
 *  in-memory fake and Postgres cannot disagree about which notifies are "another attempt". */
export function recordedCaptureId(p: {
  status: string;
  settlementSource?: string | null;
  gatewayPaymentId?: string | null;
}): string | null {
  if (p.status !== 'succeeded' || p.settlementSource !== 'webhook') return null;
  return p.gatewayPaymentId ?? null;
}

/** A balance arriving after its deposit is the second half of one sale. True only for a
 *  `balance` payment whose single sibling capture is the booking's `deposit`, and only while the
 *  two together stay within the total. Anything else is still a double capture. Shared by both
 *  repos so the in-memory fake and Postgres cannot disagree. */
export function isBalanceAfterDeposit(
  payment: { purpose: string; amount: number },
  others: Array<{ purpose: string; amount: number }>,
  bookingTotal: number,
): boolean {
  return (
    payment.purpose === 'balance' &&
    others.length === 1 &&
    others[0]!.purpose === 'deposit' &&
    others[0]!.amount + payment.amount <= bookingTotal
  );
}

/** What a success that arrives beside other captures is. The pair rule alone is not enough:
 *  payment rows stay `succeeded` after a refund, so a balance landing on a cancelled / refunded /
 *  finished booking would read as a quiet "fully paid". Only a booking that is still going ahead
 *  settles it; any other status is money with nowhere to go and takes the loud
 *  `unexpected_booking_state` path, like a full payment landing there. Shared by both repos. */
export function captureKindWithOthers(
  payment: { purpose: string; amount: number },
  others: Array<{ purpose: string; amount: number }>,
  booking: { status: string; total: number },
): 'balance_settled' | 'double_capture' | 'unexpected_booking_state' {
  if (!isBalanceAfterDeposit(payment, others, booking.total)) return 'double_capture';
  return SECURED_STATUSES.has(booking.status) ? 'balance_settled' : 'unexpected_booking_state';
}

export class PaymentSettlementError extends Error {
  constructor(
    public readonly code: 'unknown_order' | 'amount_mismatch',
    public readonly payment?: Payment,
  ) {
    super(code);
    this.name = 'PaymentSettlementError';
  }
}

export class InMemoryPaymentSettlementRepo implements PaymentSettlementRepo {
  private tail: Promise<void> = Promise.resolve();

  constructor(
    private readonly deps: {
      bookings: InMemoryBookingRepo;
      payments: InMemoryPaymentRepo;
      events: InMemoryPaymentEventRepo;
    },
    private readonly failureHook?: SettlementFailureHook,
  ) {}

  async acceptVerifiedEvent(event: VerifiedPaymentEvent, correlation?: TrackingCorrelation): Promise<PaymentSettlementOutcome> {
    return this.exclusive(async () => {
      const bookingSnapshot = this.deps.bookings.snapshotForSettlement();
      const paymentSnapshot = this.deps.payments.snapshotForSettlement();
      const eventSnapshot = this.deps.events.snapshotForSettlement();
      try {
        return await this.accept(event, correlation);
      } catch (error) {
        this.deps.bookings.restoreForSettlement(bookingSnapshot);
        this.deps.payments.restoreForSettlement(paymentSnapshot);
        this.deps.events.restoreForSettlement(eventSnapshot);
        throw error;
      }
    });
  }

  private async accept(event: VerifiedPaymentEvent, correlation?: TrackingCorrelation): Promise<PaymentSettlementOutcome> {
    const paymentRecord = this.deps.payments.findByOrderIdForSettlement(event.orderId);
    if (!paymentRecord) throw new PaymentSettlementError('unknown_order');
    if (event.amountCents !== paymentRecord.amount || event.currency !== paymentRecord.currency) {
      throw new PaymentSettlementError('amount_mismatch', this.requirePayment(event.orderId));
    }
    const booking = await this.deps.bookings.get(paymentRecord.bookingId);
    if (!booking) throw new Error(`booking_not_found_for_payment: ${paymentRecord.bookingId}`);

    const recorded = await this.deps.events.record({
      paymentId: paymentRecord.id,
      provider: event.provider,
      providerTxnId: event.providerTxnId,
      providerStatusCode: event.providerStatusCode,
      normalizedStatus: event.status,
      amount: event.amountCents,
      currency: event.currency,
      payloadSha256: event.payloadSha256,
      sanitizedPayload: event.sanitizedPayload,
      receivedAt: event.receivedAt,
    });
    if (!recorded.inserted) {
      return {
        kind: 'duplicate',
        payment: this.requirePayment(event.orderId),
        booking,
      };
    }
    await this.failureHook?.('after_event_insert');

    const captured = recordedCaptureId(paymentRecord);
    if (event.status !== 'succeeded') {
      if (paymentRecord.status === 'succeeded') {
        // Only a chargeback, or a non-success on the very capture we recorded, is a reversal.
        const staleAttempt =
          event.status !== 'charged_back' && captured !== null && captured !== event.providerTxnId;
        return {
          kind: staleAttempt ? 'stale_attempt' : 'reversal',
          payment: this.requirePayment(event.orderId),
          booking,
        };
      }
      this.deps.payments.putForSettlement({
        ...paymentRecord,
        status: 'failed',
        updatedAt: event.receivedAt,
      });
      await this.failureHook?.('after_payment_update');
      return {
        kind: 'failed',
        payment: this.requirePayment(event.orderId),
        booking,
      };
    }

    // A second capture on this same order: never overwrite the first capture's id.
    if (captured !== null && captured !== event.providerTxnId) {
      return {
        kind: 'double_capture',
        payment: this.requirePayment(event.orderId),
        booking,
        firstCaptureTxnId: captured,
      };
    }

    // Read before our own write, so this asks only about OTHER payments on the booking.
    const otherCaptures = (await this.deps.payments.findByBookingId(paymentRecord.bookingId)).filter(
      (p) => p.id !== paymentRecord.id && p.status === 'succeeded',
    );

    this.deps.payments.putForSettlement({
      ...paymentRecord,
      status: 'succeeded',
      gatewayPaymentId: event.providerTxnId,
      settledAt: event.receivedAt,
      settlementSource: 'webhook',
      updatedAt: event.receivedAt,
    });
    await this.failureHook?.('after_payment_update');

    if (otherCaptures.length) {
      return {
        kind: captureKindWithOthers(paymentRecord, otherCaptures, booking),
        payment: this.requirePayment(event.orderId),
        booking,
      };
    }

    if (booking.status !== 'payment_pending') {
      return {
        kind: 'unexpected_booking_state',
        payment: this.requirePayment(event.orderId),
        booking,
      };
    }

    // The first payment that settles IS what secured the booking (customer choice, spec 2026-10-08):
    // a customer who switched deposit -> full mid-checkout must not be told the other amount.
    if (paymentRecord.purpose !== 'balance' && paymentRecord.amount <= booking.total) {
      this.deps.bookings.setAmountDueNowForSettlement(booking.id, paymentRecord.amount);
    }
    const paid = await this.deps.bookings.setStatus(booking.id, 'paid', undefined, {
      source: 'payment_webhook',
      actorType: 'provider',
      actorId: event.provider,
      ...correlation,
      relatedEntityType: 'payment',
      relatedEntityId: paymentRecord.id,
    });
    await this.failureHook?.('after_booking_update');
    return {
      kind: 'settled',
      payment: this.requirePayment(event.orderId),
      booking: paid,
    };
  }

  private requirePayment(orderId: string): Payment {
    const payment = this.deps.payments.findByOrderIdForSettlement(orderId);
    if (!payment) throw new PaymentSettlementError('unknown_order');
    return {
      id: payment.id,
      bookingId: payment.bookingId,
      provider: payment.provider,
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      status: payment.status,
      purpose: payment.purpose,
      idempotencyKey: payment.idempotencyKey,
      attemptCount: payment.attemptCount,
      lastAttemptAt: payment.lastAttemptAt,
    };
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
