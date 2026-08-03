import { and, eq, inArray, lt, sql as dsql } from 'drizzle-orm';
import type { Db } from './client';
import { bookings, payments, refunds } from './schema';
import {
  RefundError,
  REFUNDED_STATUSES,
  RESERVING_STATUSES,
  type Refund,
  type RefundApiOutcome,
  type RefundApiStart,
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
        .where(
          and(
            eq(refunds.bookingId, input.bookingId),
            inArray(refunds.status, [...RESERVING_STATUSES]),
          ),
        );
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
        if (REFUNDED_STATUSES.includes(refund.status as RefundStatus)) {
          throw new RefundError('refund_already_confirmed');
        }
        // api_processing is confirmable on purpose: a call whose outcome we never learned is
        // resolved by a human reading PayHere's dashboard and pasting the reference here.
        if (refund.status !== 'manual_pending' && refund.status !== 'api_processing') {
          throw new RefundError('refund_not_pending');
        }
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
            // How the money actually moved, not who typed the reference.
            status: refund.status === 'api_processing' ? 'api_confirmed' : 'manual_confirmed',
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
              inArray(refunds.status, [...REFUNDED_STATUSES]),
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
      if (REFUNDED_STATUSES.includes(row.status as RefundStatus)) {
        throw new RefundError('refund_already_confirmed');
      }
      // Deliberately NOT cancellable from api_processing: that would release the reserved
      // amount while PayHere may already have paid it out.
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const [cancelled] = await tx
        .update(refunds)
        .set({ status: 'cancelled', updatedAt: new Date() })
        .where(eq(refunds.id, row.id))
        .returning();
      return toRefund(cancelled);
    });
  }

  // The claim. `for('update')` on the row plus the manual_pending guard is what makes a
  // double-click safe: the second transaction blocks, then finds the row already api_processing.
  async beginApi(input: { bookingId: string; refundId: string }): Promise<RefundApiStart> {
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.id, input.refundId), eq(refunds.bookingId, input.bookingId)))
        .for('update');
      if (!row) throw new RefundError('refund_not_found');
      if (REFUNDED_STATUSES.includes(row.status as RefundStatus)) {
        throw new RefundError('refund_already_confirmed');
      }
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const [payment] = await tx
        .select()
        .from(payments)
        .where(and(eq(payments.id, row.paymentId), eq(payments.status, 'succeeded')));
      if (!payment) throw new RefundError('payment_not_captured');
      // Gateway money only: a manual settlement's reference is a bank slip, not a PayHere
      // payment id. "0" is what PayHere writes on a FAILED payment. Sending either would ask
      // PayHere to refund a payment that does not exist.
      const gatewayPaymentId =
        payment.settlementSource === 'webhook' ? payment.gatewayPaymentId : null;
      if (!gatewayPaymentId || gatewayPaymentId === '0') {
        throw new RefundError('payment_not_refundable_by_api');
      }
      const now = new Date();
      const [claimed] = await tx
        .update(refunds)
        .set({ status: 'api_processing', apiAttemptedAt: now, updatedAt: now })
        .where(eq(refunds.id, row.id))
        .returning();
      return {
        refund: toRefund(claimed),
        gatewayPaymentId,
        isFullRefund: row.amountCents === payment.amount,
      };
    });
  }

  async settleApi(input: {
    bookingId: string;
    refundId: string;
    outcome: RefundApiOutcome;
    confirmedBy: string;
  }): Promise<RefundConfirmation> {
    if (input.outcome.kind === 'succeeded') {
      // Success reuses confirm() wholesale — same evidence rules, same fully-refunded
      // arithmetic, same booking transition. The API path must not hold a second opinion.
      const { gatewayRef, providerMessage } = input.outcome;
      const outcome = await this.confirm({
        bookingId: input.bookingId,
        refundId: input.refundId,
        gatewayRef,
        confirmedBy: input.confirmedBy,
      });
      if (!providerMessage) return outcome;
      const [withMessage] = await this.db
        .update(refunds)
        .set({ providerMessage })
        .where(eq(refunds.id, input.refundId))
        .returning();
      return { ...outcome, refund: toRefund(withMessage) };
    }
    const { providerMessage } = input.outcome;
    return this.db.transaction(async (tx) => {
      const [row] = await tx
        .select()
        .from(refunds)
        .where(and(eq(refunds.id, input.refundId), eq(refunds.bookingId, input.bookingId)))
        .for('update');
      if (!row) throw new RefundError('refund_not_found');
      if (row.status !== 'api_processing') throw new RefundError('refund_not_processing');
      const [failed] = await tx
        .update(refunds)
        .set({ status: 'api_failed', providerMessage, updatedAt: new Date() })
        .where(eq(refunds.id, row.id))
        .returning();
      // api_failed reserves nothing (RESERVING_STATUSES), so the refundable balance is whole
      // again and the agent can simply request another refund.
      return { refund: toRefund(failed), bookingFullyRefunded: false };
    });
  }

  async listStuckApi(olderThan: Date): Promise<Refund[]> {
    const rows = await this.db
      .select()
      .from(refunds)
      .where(and(eq(refunds.status, 'api_processing'), lt(refunds.apiAttemptedAt, olderThan)))
      .orderBy(refunds.apiAttemptedAt);
    return rows.map(toRefund);
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
