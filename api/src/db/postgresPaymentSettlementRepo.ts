import { eq } from 'drizzle-orm';
import type { VerifiedPaymentEvent } from '../adapters/payments';
import type { BookingRepo } from './bookingRepo';
import type { Db } from './client';
import { paymentEvents, payments, bookings } from './schema';
import {
  PaymentSettlementError,
  type PaymentSettlementOutcome,
  type PaymentSettlementRepo,
  type SettlementFailureHook,
} from './paymentSettlementRepo';
import type { Payment, PaymentStatus } from './paymentRepo';

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
  };
}

export class PostgresPaymentSettlementRepo implements PaymentSettlementRepo {
  constructor(
    private readonly db: Db,
    private readonly bookingRepo: BookingRepo,
    private readonly failureHook?: SettlementFailureHook,
  ) {}

  async acceptVerifiedEvent(event: VerifiedPaymentEvent): Promise<PaymentSettlementOutcome> {
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
        .select({ id: bookings.id, status: bookings.status })
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

      if (event.status !== 'succeeded') {
        if (payment.status === 'succeeded') {
          return { kind: 'reversal' as const, payment, bookingId: booking.id };
        }
        const [failed] = await tx
          .update(payments)
          .set({ status: 'failed', updatedAt: event.receivedAt })
          .where(eq(payments.id, payment.id))
          .returning();
        await this.failureHook?.('after_payment_update');
        return { kind: 'failed' as const, payment: failed, bookingId: booking.id };
      }

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

      if (booking.status !== 'payment_pending') {
        return {
          kind: 'unexpected_booking_state' as const,
          payment: succeeded,
          bookingId: booking.id,
        };
      }

      await tx
        .update(bookings)
        .set({ status: 'paid' })
        .where(eq(bookings.id, booking.id));
      await this.failureHook?.('after_booking_update');
      return { kind: 'settled' as const, payment: succeeded, bookingId: booking.id };
    });

    const booking = await this.bookingRepo.get(committed.bookingId);
    if (!booking) throw new Error(`booking_not_found_after_settlement: ${committed.bookingId}`);
    return {
      kind: committed.kind,
      payment: toPayment(committed.payment),
      booking,
    };
  }
}
