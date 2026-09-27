import { asc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { customerCommunicationEvents, customerCommunications } from './schema';
import type {
  CustomerCommunication,
  CustomerCommunicationEvent,
  CustomerCommunicationRepo,
  PlanCustomerCommunication,
  RecordCustomerCommunicationEvent,
} from './customerCommunicationRepo';

type CommunicationRow = typeof customerCommunications.$inferSelect;
type EventRow = typeof customerCommunicationEvents.$inferSelect;

const communication = (row: CommunicationRow): CustomerCommunication => ({
  ...row,
  kind: row.kind as CustomerCommunication['kind'],
  channel: row.channel as 'email',
  source: row.source as CustomerCommunication['source'],
  actorType: row.actorType as CustomerCommunication['actorType'],
});

const event = (row: EventRow): CustomerCommunicationEvent => ({
  ...row,
  eventType: row.eventType as CustomerCommunicationEvent['eventType'],
  detailJson: row.detailJson as Record<string, string> | null,
});

export class PostgresCustomerCommunicationRepo implements CustomerCommunicationRepo {
  constructor(private readonly db: Db) {}

  async plan(input: PlanCustomerCommunication): Promise<CustomerCommunication> {
    const inserted = await this.db.insert(customerCommunications).values(input)
      .onConflictDoNothing({ target: customerCommunications.trackingKey }).returning();
    if (inserted[0]) return communication(inserted[0]);
    const [existing] = await this.db.select().from(customerCommunications)
      .where(eq(customerCommunications.trackingKey, input.trackingKey));
    if (!existing) throw new Error('customer_communication_plan_conflict_missing');
    return communication(existing);
  }

  async recordEvent(input: RecordCustomerCommunicationEvent): Promise<CustomerCommunicationEvent> {
    const [row] = await this.db.insert(customerCommunicationEvents).values(input).returning();
    if (!row) throw new Error('customer_communication_event_insert_failed');
    return event(row);
  }

  async markProviderAccepted(id: string, provider: string | null, providerMessageId: string | null): Promise<void> {
    await this.db.update(customerCommunications).set({ provider, providerMessageId, updatedAt: new Date() })
      .where(eq(customerCommunications.id, id));
  }

  async listByBookingId(bookingId: string): Promise<CustomerCommunication[]> {
    return (await this.db.select().from(customerCommunications)
      .where(eq(customerCommunications.bookingId, bookingId))
      .orderBy(asc(customerCommunications.createdAt), asc(customerCommunications.id))).map(communication);
  }

  async listEvents(communicationId?: string): Promise<CustomerCommunicationEvent[]> {
    const query = this.db.select().from(customerCommunicationEvents);
    const rows = communicationId
      ? await query.where(eq(customerCommunicationEvents.communicationId, communicationId))
          .orderBy(asc(customerCommunicationEvents.recordedAt), asc(customerCommunicationEvents.id))
      : await query.orderBy(asc(customerCommunicationEvents.recordedAt), asc(customerCommunicationEvents.id));
    return rows.map(event);
  }
}
