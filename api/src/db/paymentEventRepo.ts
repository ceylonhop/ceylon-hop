import { randomUUID } from 'node:crypto';
import type { ProviderPaymentStatus } from '../adapters/payments';

export interface NewPaymentEvent {
  paymentId: string;
  provider: string;
  providerTxnId: string;
  providerStatusCode: string;
  normalizedStatus: ProviderPaymentStatus;
  amount: number;
  currency: string;
  payloadSha256: string;
  sanitizedPayload: Record<string, string>;
  receivedAt: Date;
}

export interface PaymentEvent extends NewPaymentEvent {
  id: string;
}

export interface RecordedPaymentEvent {
  event: PaymentEvent;
  inserted: boolean;
}

export interface PaymentEventRepo {
  record(event: NewPaymentEvent): Promise<RecordedPaymentEvent>;
  listForReconciliation(paymentId: string): Promise<PaymentEvent[]>;
}

function eventIdentity(event: NewPaymentEvent): string {
  return JSON.stringify([event.provider, event.providerTxnId, event.providerStatusCode]);
}

function cloneEvent(event: PaymentEvent): PaymentEvent {
  return {
    ...event,
    sanitizedPayload: { ...event.sanitizedPayload },
    receivedAt: new Date(event.receivedAt),
  };
}

export class InMemoryPaymentEventRepo implements PaymentEventRepo {
  private byId = new Map<string, PaymentEvent>();
  private idByIdentity = new Map<string, string>();

  async record(event: NewPaymentEvent): Promise<RecordedPaymentEvent> {
    const identity = eventIdentity(event);
    const existingId = this.idByIdentity.get(identity);
    if (existingId) {
      const existing = this.byId.get(existingId);
      if (!existing) throw new Error(`payment_event_not_found: ${existingId}`);
      return { event: cloneEvent(existing), inserted: false };
    }

    const recorded: PaymentEvent = cloneEvent({ ...event, id: randomUUID() });
    this.byId.set(recorded.id, recorded);
    this.idByIdentity.set(identity, recorded.id);
    return { event: cloneEvent(recorded), inserted: true };
  }

  async listForReconciliation(paymentId: string): Promise<PaymentEvent[]> {
    return [...this.byId.values()]
      .filter((event) => event.paymentId === paymentId)
      .sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime())
      .map(cloneEvent);
  }

  snapshotForSettlement(): {
    byId: Map<string, PaymentEvent>;
    idByIdentity: Map<string, string>;
  } {
    return {
      byId: new Map([...this.byId].map(([id, event]) => [id, cloneEvent(event)])),
      idByIdentity: new Map(this.idByIdentity),
    };
  }

  restoreForSettlement(snapshot: {
    byId: Map<string, PaymentEvent>;
    idByIdentity: Map<string, string>;
  }): void {
    this.byId = new Map([...snapshot.byId].map(([id, event]) => [id, cloneEvent(event)]));
    this.idByIdentity = new Map(snapshot.idByIdentity);
  }
}
