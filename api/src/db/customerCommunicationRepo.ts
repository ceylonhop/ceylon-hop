import { randomUUID } from 'node:crypto';
import type { CustomerCommunicationKind, CustomerCommunicationTracking } from '../adapters/email';

export type CustomerCommunicationEventType =
  | 'planned'
  | 'suppressed'
  | 'send_attempted'
  | 'provider_accepted'
  | 'send_failed'
  | 'provider_sent'
  | 'delivered'
  | 'delayed'
  | 'provider_failed'
  | 'bounced'
  | 'complained';

export interface CustomerCommunication {
  id: string;
  bookingId: string;
  kind: CustomerCommunicationKind;
  channel: 'email';
  templateKey: string;
  templateVersion: string;
  recipient: string;
  source: CustomerCommunicationTracking['source'];
  actorType: CustomerCommunicationTracking['actorType'];
  actorId: string | null;
  requestId: string | null;
  runId: string | null;
  trackingKey: string;
  payloadSha256: string;
  provider: string | null;
  providerMessageId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CustomerCommunicationEvent {
  id: string;
  communicationId: string | null;
  eventType: CustomerCommunicationEventType;
  providerEventId: string | null;
  providerMessageId: string | null;
  reasonCode: string | null;
  detailJson: Record<string, string> | null;
  occurredAt: Date;
  recordedAt: Date;
}

export type PlanCustomerCommunication = Omit<CustomerCommunication, 'id' | 'provider' | 'providerMessageId' | 'createdAt' | 'updatedAt'>;
export type RecordCustomerCommunicationEvent = Omit<CustomerCommunicationEvent, 'id' | 'recordedAt'>;
export type RecordProviderCommunicationEvent = RecordCustomerCommunicationEvent & {
  providerEventId: string;
  providerMessageId: string;
};

export type CustomerCommunicationReconciliationFinding =
  | {
      kind: 'communication_attempt_unresolved';
      communicationId: string;
      bookingId: string;
      communicationKind: CustomerCommunicationKind;
      occurredAt: Date;
      providerMessageId: null;
      eventType: 'send_attempted';
    }
  | {
      kind: 'orphan_provider_event';
      communicationId: null;
      bookingId: null;
      communicationKind: null;
      occurredAt: Date;
      providerMessageId: string;
      eventType: CustomerCommunicationEventType;
    }
  | {
      kind: 'provider_communication_failure';
      communicationId: string;
      bookingId: string;
      communicationKind: CustomerCommunicationKind;
      occurredAt: Date;
      providerMessageId: string | null;
      eventType: 'provider_failed' | 'bounced' | 'complained';
    };

export interface CustomerCommunicationRepo {
  plan(input: PlanCustomerCommunication): Promise<CustomerCommunication>;
  recordEvent(input: RecordCustomerCommunicationEvent): Promise<CustomerCommunicationEvent>;
  recordProviderEvent(input: RecordProviderCommunicationEvent): Promise<{
    event: CustomerCommunicationEvent;
    inserted: boolean;
  }>;
  markProviderAccepted(id: string, provider: string | null, providerMessageId: string | null): Promise<void>;
  findByProviderMessageId(providerMessageId: string): Promise<CustomerCommunication | null>;
  listByBookingId(bookingId: string): Promise<CustomerCommunication[]>;
  listEvents(communicationId?: string): Promise<CustomerCommunicationEvent[]>;
  /** Explicit failures and invariants only. Missing delivery by itself is never a finding. */
  listReconciliationFindings(staleBefore: Date): Promise<CustomerCommunicationReconciliationFinding[]>;
}

export class InMemoryCustomerCommunicationRepo implements CustomerCommunicationRepo {
  private readonly communications = new Map<string, CustomerCommunication>();
  private readonly byTrackingKey = new Map<string, string>();
  private readonly events: CustomerCommunicationEvent[] = [];

  async plan(input: PlanCustomerCommunication): Promise<CustomerCommunication> {
    const existingId = this.byTrackingKey.get(input.trackingKey);
    if (existingId) return structuredClone(this.communications.get(existingId)!);
    const now = new Date();
    const row: CustomerCommunication = {
      ...structuredClone(input), id: randomUUID(), provider: null, providerMessageId: null,
      createdAt: now, updatedAt: now,
    };
    this.communications.set(row.id, row);
    this.byTrackingKey.set(row.trackingKey, row.id);
    return structuredClone(row);
  }

  async recordEvent(input: RecordCustomerCommunicationEvent): Promise<CustomerCommunicationEvent> {
    const row = { ...structuredClone(input), id: randomUUID(), recordedAt: new Date() };
    this.events.push(row);
    return structuredClone(row);
  }

  async recordProviderEvent(input: RecordProviderCommunicationEvent): Promise<{
    event: CustomerCommunicationEvent;
    inserted: boolean;
  }> {
    const existing = this.events.find((row) => row.providerEventId === input.providerEventId);
    if (existing) return { event: structuredClone(existing), inserted: false };
    return { event: await this.recordEvent(input), inserted: true };
  }

  async markProviderAccepted(id: string, provider: string | null, providerMessageId: string | null): Promise<void> {
    const row = this.communications.get(id);
    if (!row) return;
    this.communications.set(id, { ...row, provider, providerMessageId, updatedAt: new Date() });
  }

  async findByProviderMessageId(providerMessageId: string): Promise<CustomerCommunication | null> {
    const row = [...this.communications.values()]
      .find((communication) => communication.providerMessageId === providerMessageId);
    return row ? structuredClone(row) : null;
  }

  async listByBookingId(bookingId: string): Promise<CustomerCommunication[]> {
    return [...this.communications.values()].filter((row) => row.bookingId === bookingId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).map((row) => structuredClone(row));
  }

  async listEvents(communicationId?: string): Promise<CustomerCommunicationEvent[]> {
    return this.events.filter((row) => !communicationId || row.communicationId === communicationId)
      .map((row) => structuredClone(row));
  }

  async listReconciliationFindings(staleBefore: Date): Promise<CustomerCommunicationReconciliationFinding[]> {
    const terminal = new Set(
      this.events
        .filter((row) => row.communicationId && (row.eventType === 'provider_accepted' || row.eventType === 'send_failed'))
        .map((row) => row.communicationId as string),
    );
    const findings: CustomerCommunicationReconciliationFinding[] = [];
    const unresolvedReported = new Set<string>();
    for (const row of [...this.events].sort((a, b) =>
      a.occurredAt.getTime() - b.occurredAt.getTime() || a.id.localeCompare(b.id))) {
      if (!row.communicationId && row.providerMessageId) {
        findings.push({
          kind: 'orphan_provider_event', communicationId: null, bookingId: null,
          communicationKind: null, occurredAt: new Date(row.occurredAt),
          providerMessageId: row.providerMessageId, eventType: row.eventType,
        });
        continue;
      }
      if (!row.communicationId) continue;
      const communication = this.communications.get(row.communicationId);
      if (!communication) continue;
      if (
        row.eventType === 'send_attempted' &&
        row.occurredAt <= staleBefore &&
        !terminal.has(row.communicationId) &&
        !unresolvedReported.has(row.communicationId)
      ) {
        unresolvedReported.add(row.communicationId);
        findings.push({
          kind: 'communication_attempt_unresolved', communicationId: row.communicationId,
          bookingId: communication.bookingId, communicationKind: communication.kind,
          occurredAt: new Date(row.occurredAt), providerMessageId: null, eventType: 'send_attempted',
        });
      } else if (row.eventType === 'provider_failed' || row.eventType === 'bounced' || row.eventType === 'complained') {
        findings.push({
          kind: 'provider_communication_failure', communicationId: row.communicationId,
          bookingId: communication.bookingId, communicationKind: communication.kind,
          occurredAt: new Date(row.occurredAt), providerMessageId: row.providerMessageId,
          eventType: row.eventType,
        });
      }
    }
    return findings.sort((a, b) => a.occurredAt.getTime() - b.occurredAt.getTime());
  }
}
