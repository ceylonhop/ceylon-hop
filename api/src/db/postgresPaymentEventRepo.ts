import { and, asc, eq } from 'drizzle-orm';
import type { ProviderPaymentStatus } from '../adapters/payments';
import type { Db } from './client';
import type {
  NewPaymentEvent,
  PaymentEvent,
  PaymentEventRepo,
  RecordedPaymentEvent,
} from './paymentEventRepo';
import { paymentEvents } from './schema';

type Row = typeof paymentEvents.$inferSelect;

const toPaymentEvent = (row: Row): PaymentEvent => ({
  id: row.id,
  paymentId: row.paymentId,
  provider: row.provider,
  providerTxnId: row.providerTxnId,
  providerStatusCode: row.providerStatusCode,
  normalizedStatus: row.normalizedStatus as ProviderPaymentStatus,
  amount: row.amount,
  currency: row.currency,
  payloadSha256: row.payloadSha256,
  sanitizedPayload: row.sanitizedPayload,
  receivedAt: row.receivedAt,
});

export class PostgresPaymentEventRepo implements PaymentEventRepo {
  constructor(private readonly db: Db) {}

  async record(event: NewPaymentEvent): Promise<RecordedPaymentEvent> {
    const [inserted] = await this.db
      .insert(paymentEvents)
      .values(event)
      .onConflictDoNothing({
        target: [
          paymentEvents.provider,
          paymentEvents.providerTxnId,
          paymentEvents.providerStatusCode,
        ],
      })
      .returning();
    if (inserted) return { event: toPaymentEvent(inserted), inserted: true };

    const [existing] = await this.db
      .select()
      .from(paymentEvents)
      .where(
        and(
          eq(paymentEvents.provider, event.provider),
          eq(paymentEvents.providerTxnId, event.providerTxnId),
          eq(paymentEvents.providerStatusCode, event.providerStatusCode),
        ),
      );
    if (!existing) throw new Error('payment_event_conflict_without_existing_row');
    return { event: toPaymentEvent(existing), inserted: false };
  }

  async listForReconciliation(paymentId: string): Promise<PaymentEvent[]> {
    const rows = await this.db
      .select()
      .from(paymentEvents)
      .where(eq(paymentEvents.paymentId, paymentId))
      .orderBy(asc(paymentEvents.receivedAt), asc(paymentEvents.id));
    return rows.map(toPaymentEvent);
  }
}
