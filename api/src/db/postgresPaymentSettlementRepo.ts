import { and, eq, ne } from 'drizzle-orm';
import type { VerifiedPaymentEvent } from '../adapters/payments';
import type { BookingRepo } from './bookingRepo';
import type { Db } from './client';
import { paymentEvents, payments, bookings } from './schema';
import { applyBookingStatusTransition } from './postgresBookingRepo';
import {
  isBalanceAfterDeposit,
  PaymentSettlementError,
  recordedCaptureId,
  type PaymentSettlementOutcome,
  type PaymentSettlementRepo,
  type SettlementFailureHook,
} from './paymentSettlementRepo';
import type { Payment, PaymentPurpose, PaymentStatus } from './paymentRepo';
import type { TrackingCorrelation } from '../domain/trackingContract';

type PaymentRow = typeof payments.$inferSelect;

function toPayment(row: PaymentRow): Payment {
  return {
    id: row.id,
    bookingId: row.bookingId,
    provider: row.provider,
    orderId: row.orderId,
    amount: row.amount,
    currency: row.currency,
    status: row.status as PaymentStatus,
    idempotencyKey: row.idempotencyKey,
    purpose: row.purpose as PaymentPurpose,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
  };
}

export class PostgresPaymentSettlementRepo implements PaymentSettlementRepo {
  constructor(
    private readonly db: Db,
    private readonly bookingRepo: BookingRepo,
    private readonly failureHook?: SettlementFailureHook,
    private readonly options: { transitionTrackingEnabled?: boolean } = {},
  ) {}

  async acceptVerifiedEvent(event: VerifiedPaymentEvent, correlation?: TrackingCorrelation): Promise<PaymentSettlementOutcome> {
    const committed = await this.db.transaction(async (tx) => {
      const [payment] = await tx
        .select()
        .from(payments)
        .where(eq(payments.orderId, event.orderId))
        .for('update');
      if (!payment) throw new PaymentSettlementError('unknown_order');
      if (event.amountCents !== payment.amount || event.currency !== payment.currency) {
        throw new PaymentSettlementError('amount_mismatch', toPayment(payment));
      }

      const [booking] = await tx
        .select({ id: bookings.id, status: bookings.status, total: bookings.total })
        .from(bookings)
        .where(eq(bookings.id, payment.bookingId))
        .for('update');
      if (!booking) throw new Error(`booking_not_found_for_payment: ${payment.bookingId}`);

      const [inserted] = await tx
        .insert(paymentEvents)
        .values({
          paymentId: payment.id,
          provider: event.provider,
          providerTxnId: event.providerTxnId,
          providerStatusCode: event.providerStatusCode,
          normalizedStatus: event.status,
          amount: event.amountCents,
          currency: event.currency,
          payloadSha256: event.payloadSha256,
          sanitizedPayload: event.sanitizedPayload,
          receivedAt: event.receivedAt,
        })
        .onConflictDoNothing({
          target: [
            paymentEvents.paymentId,
            paymentEvents.provider,
            paymentEvents.providerTxnId,
            paymentEvents.providerStatusCode,
          ],
        })
        .returning({ id: paymentEvents.id });

      if (!inserted) {
        return { kind: 'duplicate' as const, payment, bookingId: booking.id };
      }
      await this.failureHook?.('after_event_insert');

      const captured = recordedCaptureId(payment);
      if (event.status !== 'succeeded') {
        if (payment.status === 'succeeded') {
          // Only a chargeback, or a non-success on the very capture we recorded, is a reversal.
          const staleAttempt =
            event.status !== 'charged_back' && captured !== null && captured !== event.providerTxnId;
          return {
            kind: staleAttempt ? ('stale_attempt' as const) : ('reversal' as const),
            payment,
            bookingId: booking.id,
          };
        }
        const [failed] = await tx
          .update(payments)
          .set({ status: 'failed', updatedAt: event.receivedAt })
          .where(eq(payments.id, payment.id))
          .returning();
        await this.failureHook?.('after_payment_update');
        return { kind: 'failed' as const, payment: failed, bookingId: booking.id };
      }

      // A second capture on this same order: never overwrite the first capture's id.
      if (captured !== null && captured !== event.providerTxnId) {
        return {
          kind: 'double_capture' as const,
          payment,
          bookingId: booking.id,
          firstCaptureTxnId: captured,
        };
      }

      // Has some OTHER payment on this booking already captured? Read inside the transaction,
      // after the booking row is locked FOR UPDATE above, so a concurrent settle on a sibling
      // payment can't slip in between this read and our write — and before our own update, so
      // this row is not its own evidence. `ne` is the whole point: an ordinary retry re-settling
      // the same payment must stay a plain settlement.
      const otherCaptures = await tx
        .select({ id: payments.id, purpose: payments.purpose, amount: payments.amount })
        .from(payments)
        .where(
          and(
            eq(payments.bookingId, payment.bookingId),
            eq(payments.status, 'succeeded'),
            ne(payments.id, payment.id),
          ),
        );

      const [succeeded] = await tx
        .update(payments)
        .set({
          status: 'succeeded',
          gatewayPaymentId: event.providerTxnId,
          settledAt: event.receivedAt,
          settlementSource: 'webhook',
          updatedAt: event.receivedAt,
        })
        .where(eq(payments.id, payment.id))
        .returning();
      await this.failureHook?.('after_payment_update');

      // Keep the capture (the money moved; the refund ceiling must reflect it) but leave the
      // booking as the first settlement left it and hand the case to a human, loudly — unless it
      // is the balance of a deposit booking (isBalanceAfterDeposit), which is one sale in two parts.
      if (otherCaptures.length) {
        const kind = isBalanceAfterDeposit(payment, otherCaptures, booking.total)
          ? ('balance_settled' as const)
          : ('double_capture' as const);
        return { kind, payment: succeeded, bookingId: booking.id };
      }

      if (booking.status !== 'payment_pending') {
        return {
          kind: 'unexpected_booking_state' as const,
          payment: succeeded,
          bookingId: booking.id,
        };
      }

      await applyBookingStatusTransition(tx, {
        id: booking.id,
        to: 'paid',
        transitionTrackingEnabled: this.options.transitionTrackingEnabled,
        context: {
          source: 'payment_webhook',
          actorType: 'provider',
          actorId: event.provider,
          ...correlation,
          relatedEntityType: 'payment',
          relatedEntityId: payment.id,
        },
      });
      await this.failureHook?.('after_booking_update');
      return { kind: 'settled' as const, payment: succeeded, bookingId: booking.id };
    });

    const booking = await this.bookingRepo.get(committed.bookingId);
    if (!booking) throw new Error(`booking_not_found_after_settlement: ${committed.bookingId}`);
    const firstCaptureTxnId = 'firstCaptureTxnId' in committed ? committed.firstCaptureTxnId : undefined;
    return {
      kind: committed.kind,
      payment: toPayment(committed.payment),
      booking,
      ...(firstCaptureTxnId ? { firstCaptureTxnId } : {}),
    } as PaymentSettlementOutcome;
  }
}
