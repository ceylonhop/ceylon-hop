import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { payments } from './schema';
import type { PaymentRepo, NewPayment, Payment, PaymentStatus } from './paymentRepo';

type Row = typeof payments.$inferSelect;
const toPayment = (r: Row): Payment => ({
  id: r.id,
  bookingId: r.bookingId,
  provider: r.provider,
  orderId: r.orderId,
  amount: r.amount,
  currency: r.currency,
  status: r.status as PaymentStatus,
  idempotencyKey: r.idempotencyKey,
});

export class PostgresPaymentRepo implements PaymentRepo {
  constructor(private readonly db: Db) {}

  async create(p: NewPayment): Promise<Payment> {
    const existing = await this.findByIdempotencyKey(p.idempotencyKey);
    if (existing) return existing;
    const [row] = await this.db
      .insert(payments)
      .values({ ...p, status: 'pending' })
      .returning();
    return toPayment(row);
  }

  async findByIdempotencyKey(key: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.idempotencyKey, key));
    return row ? toPayment(row) : null;
  }

  async findByOrderId(orderId: string): Promise<Payment | null> {
    const [row] = await this.db.select().from(payments).where(eq(payments.orderId, orderId));
    return row ? toPayment(row) : null;
  }

  async findByBookingId(bookingId: string): Promise<Payment[]> {
    const rows = await this.db.select().from(payments).where(eq(payments.bookingId, bookingId));
    return rows.map(toPayment);
  }

  async markSucceeded(id: string): Promise<Payment> {
    const [row] = await this.db
      .update(payments)
      .set({ status: 'succeeded' })
      .where(eq(payments.id, id))
      .returning();
    if (!row) throw new Error(`payment_not_found: ${id}`);
    return toPayment(row);
  }

  async markFailed(id: string): Promise<Payment> {
    const [row] = await this.db
      .update(payments)
      .set({ status: 'failed' })
      .where(eq(payments.id, id))
      .returning();
    if (!row) throw new Error(`payment_not_found: ${id}`);
    return toPayment(row);
  }
}
