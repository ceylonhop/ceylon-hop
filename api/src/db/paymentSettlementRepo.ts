import type { VerifiedPaymentEvent } from '../adapters/payments';
import type { Booking } from './bookingRepo';
import { InMemoryBookingRepo } from './bookingRepo';
import { InMemoryPaymentEventRepo } from './paymentEventRepo';
import type { Payment } from './paymentRepo';
import { InMemoryPaymentRepo } from './paymentRepo';

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
  // PayHere status 0: the attempt is still in flight. Recorded as evidence; the payment stays as it
  // was. Not a decline — a "failed" here told the customer to pay again while the money could land.
  | { kind: 'pending'; payment: Payment; booking: Booking }
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
  | { kind: 'unexpected_booking_state'; payment: Payment; booking: Booking };

export interface PaymentSettlementRepo {
  acceptVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentSettlementOutcome>;
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

  async acceptVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentSettlementOutcome> {
    return this.exclusive(async () => {
      const bookingSnapshot = this.deps.bookings.snapshotForSettlement();
      const paymentSnapshot = this.deps.payments.snapshotForSettlement();
      const eventSnapshot = this.deps.events.snapshotForSettlement();
      try {
        return await this.accept(event);
      } catch (error) {
        this.deps.bookings.restoreForSettlement(bookingSnapshot);
        this.deps.payments.restoreForSettlement(paymentSnapshot);
        this.deps.events.restoreForSettlement(eventSnapshot);
        throw error;
      }
    });
  }

  private async accept(event: VerifiedPaymentEvent): Promise<PaymentSettlementOutcome> {
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
        // Only a chargeback, or a non-success on the very capture we recorded, is a reversal. A
        // "pending" never is: it cannot take money back, whichever attempt it names.
        const staleAttempt =
          event.status === 'pending' ||
          (event.status !== 'charged_back' && captured !== null && captured !== event.providerTxnId);
        return {
          kind: staleAttempt ? 'stale_attempt' : 'reversal',
          payment: this.requirePayment(event.orderId),
          booking,
        };
      }
      if (event.status === 'pending') {
        return { kind: 'pending', payment: this.requirePayment(event.orderId), booking };
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
    const alreadyCaptured = (await this.deps.payments.findByBookingId(paymentRecord.bookingId)).some(
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

    if (alreadyCaptured) {
      return {
        kind: 'double_capture',
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

    const paid = await this.deps.bookings.setStatus(booking.id, 'paid');
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
