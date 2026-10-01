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
}
