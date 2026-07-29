import { and, eq, inArray, ne, sql as dsql } from 'drizzle-orm';
import type { Db } from './client';
import { bookings, payments, refunds } from './schema';
import {
  RefundError,
  type Refund,
  type RefundConfirmation,
  type RefundRepo,
  type RefundStatus,
} from './refundRepo';

type Row = typeof refunds.$inferSelect;
const toRefund = (row: Row): Refund => ({
  ...row,
  status: row.status as RefundStatus,
});

function uniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 6 && current && typeof current === 'object'; depth++) {
    const value = current as { code?: unknown; cause?: unknown };
    if (value.code === '23505') return true;
    current = value.cause;
  }
  return false;
}

export class PostgresRefundRepo implements RefundRepo {
  constructor(private readonly db: Db) {}

  async request(input: {
    bookingId: string;
    amountCents: number;
    currency: string;
    reason: string;
    requestedBy: string;
  }): Promise<Refund> {
    return this.db.transaction(async (tx) => {
      const [booking] = await tx
        .select({ id: bookings.id })
        .from(bookings)
        .where(eq(bookings.id, input.bookingId))
        .for('update');
      if (!booking) throw new RefundError('booking_not_found');
      const captured = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.bookingId, input.bookingId), eq(payments.status, 'succeeded')))
        .for('update');
      if (captured.length === 0) throw new RefundError('payment_not_captured');
      if (captured.some((payment) => payment.currency !== input.currency)) {
        throw new RefundError('currency_mismatch');
      }
      const [{ reserved }] = await tx
        .select({ reserved: dsql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
        .from(refunds)
        .where(and(eq(refunds.bookingId, input.bookingId), ne(refunds.status, 'cancelled')));
      const capturedCents = captured.reduce((sum, payment) => sum + payment.amount, 0);
      if (reserved + input.amountCents > capturedCents) {
        throw new RefundError('refund_exceeds_captured');
      }
      const now = new Date();
      const [row] = await tx
        .insert(refunds)
        .values({
          bookingId: input.bookingId,
          paymentId: captured[0].id,
          provider: captured[0].provider,
          amountCents: input.amountCents,
          currency: input.currency,
          status: 'manual_pending',
          reason: input.reason,
          requestedBy: input.requestedBy,
          requestedAt: now,
          updatedAt: now,
        })
        .returning();
      return toRefund(row);
    });
  }

  async confirm(input: {
    bookingId: string;
    refundId: string;
    gatewayRef: string;
    confirmedBy: string;
  }): Promise<RefundConfirmation> {
    try {
      return await this.db.transaction(async (tx) => {
        const [booking] = await tx
          .select({ id: bookings.id, status: bookings.status })
          .from(bookings)
          .where(eq(bookings.id, input.bookingId))
          .for('update');
        if (!booking) throw new RefundError('booking_not_found');
        const [refund] = await tx
          .select()
          .from(refunds)
          .where(and(eq(refunds.id, input.refundId), eq(refunds.bookingId, input.bookingId)))
          .for('update');
        if (!refund) throw new RefundError('refund_not_found');
        if (refund.status === 'manual_confirmed') {
          throw new RefundError('refund_already_confirmed');
        }
        if (refund.status !== 'manual_pending') throw new RefundError('refund_not_pending');
        const captured = await tx
          .select()
          .from(payments)
          .where(and(eq(payments.bookingId, input.bookingId), eq(payments.status, 'succeeded')))
          .for('update');
        const capturedCents = captured.reduce((sum, payment) => sum + payment.amount, 0);
        const now = new Date();
        const [confirmed] = await tx
          .update(refunds)
          .set({
            status: 'manual_confirmed',
            gatewayRef: input.gatewayRef,
            confirmedBy: input.confirmedBy,
            confirmedAt: now,
            updatedAt: now,
          })
          .where(eq(refunds.id, refund.id))
          .returning();
        const [{ refunded }] = await tx
          .select({ refunded: dsql<number>`coalesce(sum(${refunds.amountCents}), 0)::int` })
          .from(refunds)
          .where(
            and(
              eq(refunds.bookingId, input.bookingId),
              eq(refunds.status, 'manual_confirmed'),
            ),
          );
        if (refunded > capturedCents) throw new RefundError('refund_exceeds_captured');
        const fully = refunded === capturedCents;
        if (fully) {
          const [updated] = await tx
            .update(bookings)
            .set({ status: 'refunded' })
            .where(
              and(
                eq(bookings.id, input.bookingId),
                inArray(bookings.status, ['paid', 'confirmed', 'cancelled']),
              ),
            )
            .returning({ id: bookings.id });
          if (!updated) throw new RefundError('booking_state_conflict');
        }
        return { refund: toRefund(confirmed), bookingFullyRefunded: fully };
      });
    } catch (error) {
      if (uniqueViolation(error)) throw new RefundError('gateway_ref_conflict');
      throw error;
    }
  }

  async cancel(input: { bookingId: string; refundId: string }): Promise<Refund> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.id, input.refundId), eq(refunds.bookingId, input.bookingId)))
        .for('update');
      if (!row) throw new RefundError('refund_not_found');
      if (row.status === 'manual_confirmed') throw new RefundError('refund_already_confirmed');
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const [cancelled] = await tx
        .update(refunds)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(refunds.id, row.id))
        .returning();
      return toRefund(cancelled);
    });
  }

  async list(bookingId: string): Promise<Refund[]> {
    const rows = await this.db
      .select()
      .from(refunds)
      .where(eq(refunds.bookingId, bookingId))
      .orderBy(refunds.createdAt);
    return rows.map(toRefund);
  }
}
