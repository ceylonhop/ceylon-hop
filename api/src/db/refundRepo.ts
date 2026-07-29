import { randomUUID } from 'node:crypto';
import type { BookingRepo } from './bookingRepo';
import type { PaymentRepo } from './paymentRepo';

export type RefundStatus = 'manual_pending' | 'manual_confirmed' | 'cancelled';

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
      | 'booking_state_conflict',
  ) {
    super(code);
    this.name = 'RefundError';
  }
}

export interface RefundConfirmation {
  refund: Refund;
  bookingFullyRefunded: boolean;
}

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
        .filter((refund) => refund.bookingId === input.bookingId && refund.status !== 'cancelled')
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
      if (row.status === 'manual_confirmed') throw new RefundError('refund_already_confirmed');
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
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
        status: 'manual_confirmed',
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
            refund.bookingId === input.bookingId && refund.status === 'manual_confirmed',
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
      if (row.status === 'manual_confirmed') throw new RefundError('refund_already_confirmed');
      if (row.status !== 'manual_pending') throw new RefundError('refund_not_pending');
      const cancelled = { ...row, status: 'cancelled' as const, updatedAt: new Date() };
      this.rows.set(row.id, cancelled);
      return structuredClone(cancelled);
    });
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
