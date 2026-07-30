import { and, eq } from 'drizzle-orm';
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
    const now = new Date();
    const [row] = await this.db
      .update(payments)
      // This legacy repository method has no gateway event to cite. Keep its stable
      // interface for tests/internal callers while making the lack of gateway provenance
      // explicit; real webhook settlement uses PostgresPaymentSettlementRepo atomically.
      .set({
        status: 'succeeded',
        settledAt: now,
        settlementSource: 'legacy_backfill',
        updatedAt: now,
      })
      .where(eq(payments.id, id))
      .returning();
    if (!row) throw new Error(`payment_not_found: ${id}`);
    return toPayment(row);
  }

  // Out-of-band settlement (cash / bank transfer). The provenance is explicit — 'manual' says a
  // human recorded this, never a gateway — and the operator's optional reference is the only
  // evidence there is, so it goes where a gateway id would. Who did it lives in the booking's
  // activity notes, written by the route.
  async markSucceededManually(id: string, evidence: { reference: string | null }): Promise<Payment> {
    const now = new Date();
    const [row] = await this.db
      .update(payments)
      .set({
        status: 'succeeded',
        gatewayPaymentId: evidence.reference,
        settledAt: now,
        settlementSource: 'manual',
        updatedAt: now,
      })
      .where(eq(payments.id, id))
      .returning();
    if (!row) throw new Error(`payment_not_found: ${id}`);
    return toPayment(row);
  }

  // Cheapest possible existence check — the watchdog asks this once per paid booking on every
  // ~15-min sweep, and nothing downstream wants the row itself.
  async hasManualSettlement(bookingId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: payments.id })
      .from(payments)
      .where(
        and(
          eq(payments.bookingId, bookingId),
          eq(payments.status, 'succeeded'),
          eq(payments.settlementSource, 'manual'),
        ),
      )
      .limit(1);
    return Boolean(row);
  }

  async markFailed(id: string): Promise<Payment> {
    const [row] = await this.db
      .update(payments)
      .set({ status: 'failed', updatedAt: new Date() })
      .where(eq(payments.id, id))
      .returning();
    if (!row) throw new Error(`payment_not_found: ${id}`);
    return toPayment(row);
  }
}
