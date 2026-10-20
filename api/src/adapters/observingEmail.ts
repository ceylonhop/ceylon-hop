import { createHash } from 'node:crypto';
import type { CustomerCommunication, CustomerCommunicationRepo } from '../db/customerCommunicationRepo';
import type { EmailAdapter, EmailMessage, SendOutcome } from './email';

function payloadHash(message: EmailMessage): string {
  return createHash('sha256').update(JSON.stringify({
    to: message.to,
    subject: message.subject,
    html: message.html,
    text: message.text ?? '',
  })).digest('hex');
}

/**
 * Records facts around the existing adapter call. It never decides whether a message may
 * send and it never makes a second provider call. Ledger failures are deliberately isolated:
 * observability must not turn a successful payment webhook into a customer-facing failure.
 */
export class ObservingEmailAdapter implements EmailAdapter {
  constructor(
    private readonly inner: EmailAdapter,
    private readonly ledger: CustomerCommunicationRepo,
  ) {}

  async send(message: EmailMessage): Promise<SendOutcome | void> {
    if (!message.tracking) return this.inner.send(message);

    const communication = await this.safe(() => this.ledger.plan({
      bookingId: message.tracking!.bookingId,
      kind: message.tracking!.kind,
      channel: 'email',
      templateKey: message.tracking!.templateKey,
      templateVersion: message.tracking!.templateVersion,
      recipient: message.to,
      source: message.tracking!.source,
      actorType: message.tracking!.actorType,
      actorId: message.tracking!.actorId ?? null,
      requestId: message.tracking!.requestId ?? null,
      runId: message.tracking!.runId ?? null,
      trackingKey: message.tracking!.trackingKey,
      payloadSha256: payloadHash(message),
    }));
    await this.event(communication, 'planned');

    try {
      const outcome = await this.inner.send(message);
      if (outcome && !outcome.delivered) {
        await this.event(communication, 'suppressed', outcome.reason);
        return outcome;
      }

      await this.event(communication, 'send_attempted');
      const provider = outcome?.delivered ? outcome.provider ?? null : null;
      const providerMessageId = outcome?.delivered ? outcome.providerMessageId ?? null : null;
      if (communication) {
        await this.safe(() => this.ledger.markProviderAccepted(communication.id, provider, providerMessageId));
      }
      await this.event(communication, 'provider_accepted', null, providerMessageId);
      return outcome;
    } catch (error) {
      await this.event(communication, 'send_attempted');
      await this.event(communication, 'send_failed', 'provider_error');
      throw error;
    }
  }

  private async event(
    communication: CustomerCommunication | undefined,
    eventType: 'planned' | 'suppressed' | 'send_attempted' | 'provider_accepted' | 'send_failed',
    reasonCode: string | null = null,
    providerMessageId: string | null = null,
  ): Promise<void> {
    if (!communication) return;
    await this.safe(() => this.ledger.recordEvent({
      communicationId: communication.id,
      eventType,
      providerEventId: null,
      providerMessageId,
      reasonCode,
      detailJson: null,
      occurredAt: new Date(),
    }));
  }

  private async safe<T>(operation: () => Promise<T>): Promise<T | undefined> {
    try {
      return await operation();
    } catch (error) {
      console.error('customer_communication_tracking_failed', error instanceof Error ? error.message : 'unknown');
      return undefined;
    }
  }
}
