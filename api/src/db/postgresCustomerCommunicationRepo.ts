import { and, asc, eq, inArray, isNull, lte, or } from 'drizzle-orm';
import type { Db } from './client';
import { customerCommunicationEvents, customerCommunications } from './schema';
import type {
  CustomerCommunication,
  CustomerCommunicationEvent,
  CustomerCommunicationReconciliationFinding,
  CustomerCommunicationRepo,
  PlanCustomerCommunication,
  RecordCustomerCommunicationEvent,
  RecordProviderCommunicationEvent,
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

  async recordProviderEvent(input: RecordProviderCommunicationEvent): Promise<{
    event: CustomerCommunicationEvent;
    inserted: boolean;
  }> {
    const inserted = await this.db.insert(customerCommunicationEvents).values(input)
      .onConflictDoNothing({ target: customerCommunicationEvents.providerEventId }).returning();
    if (inserted[0]) return { event: event(inserted[0]), inserted: true };
    const [existing] = await this.db.select().from(customerCommunicationEvents)
      .where(eq(customerCommunicationEvents.providerEventId, input.providerEventId));
    if (!existing) throw new Error('customer_communication_provider_event_conflict_missing');
    return { event: event(existing), inserted: false };
  }

  async markProviderAccepted(id: string, provider: string | null, providerMessageId: string | null): Promise<void> {
    await this.db.update(customerCommunications).set({ provider, providerMessageId, updatedAt: new Date() })
      .where(eq(customerCommunications.id, id));
  }

  async findByProviderMessageId(providerMessageId: string): Promise<CustomerCommunication | null> {
    const [row] = await this.db.select().from(customerCommunications)
      .where(eq(customerCommunications.providerMessageId, providerMessageId));
    return row ? communication(row) : null;
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

  async listReconciliationFindings(staleBefore: Date): Promise<CustomerCommunicationReconciliationFinding[]> {
    const relevant = await this.db.select().from(customerCommunicationEvents).where(or(
      and(
        eq(customerCommunicationEvents.eventType, 'send_attempted'),
        lte(customerCommunicationEvents.occurredAt, staleBefore),
      ),
      isNull(customerCommunicationEvents.communicationId),
      inArray(customerCommunicationEvents.eventType, ['provider_failed', 'bounced', 'complained']),
    )).orderBy(asc(customerCommunicationEvents.occurredAt), asc(customerCommunicationEvents.id));
    const communicationIds = [...new Set(
      relevant.flatMap((row) => row.communicationId ? [row.communicationId] : []),
    )];
    const communicationRows = communicationIds.length
      ? await this.db.select().from(customerCommunications)
          .where(inArray(customerCommunications.id, communicationIds))
      : [];
    const byId = new Map(communicationRows.map((row) => [row.id, communication(row)]));
    const attemptedIds = [...new Set(
      relevant
        .filter((row) => row.eventType === 'send_attempted' && row.communicationId)
        .map((row) => row.communicationId as string),
    )];
    const terminalIds = new Set<string>();
    if (attemptedIds.length) {
      const terminalRows = await this.db
        .select({ communicationId: customerCommunicationEvents.communicationId })
        .from(customerCommunicationEvents)
        .where(and(
          inArray(customerCommunicationEvents.communicationId, attemptedIds),
          inArray(customerCommunicationEvents.eventType, ['provider_accepted', 'send_failed']),
        ));
      for (const row of terminalRows) if (row.communicationId) terminalIds.add(row.communicationId);
    }

    const findings: CustomerCommunicationReconciliationFinding[] = [];
    const unresolvedReported = new Set<string>();
    for (const row of relevant) {
      if (!row.communicationId && row.providerMessageId) {
        findings.push({
          kind: 'orphan_provider_event', communicationId: null, bookingId: null,
          communicationKind: null, occurredAt: row.occurredAt,
          providerMessageId: row.providerMessageId,
          eventType: row.eventType as CustomerCommunicationEvent['eventType'],
        });
        continue;
      }
      if (!row.communicationId) continue;
      const parent = byId.get(row.communicationId);
      if (!parent) continue;
      if (
        row.eventType === 'send_attempted' &&
        !terminalIds.has(row.communicationId) &&
        !unresolvedReported.has(row.communicationId)
      ) {
        unresolvedReported.add(row.communicationId);
        findings.push({
          kind: 'communication_attempt_unresolved', communicationId: row.communicationId,
          bookingId: parent.bookingId, communicationKind: parent.kind,
          occurredAt: row.occurredAt, providerMessageId: null, eventType: 'send_attempted',
        });
      } else if (row.eventType === 'provider_failed' || row.eventType === 'bounced' || row.eventType === 'complained') {
        findings.push({
          kind: 'provider_communication_failure', communicationId: row.communicationId,
          bookingId: parent.bookingId, communicationKind: parent.kind,
          occurredAt: row.occurredAt, providerMessageId: row.providerMessageId,
          eventType: row.eventType,
        });
      }
    }
    return findings.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}
