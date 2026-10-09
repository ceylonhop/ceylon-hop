import { describe, expect, it } from 'vitest';
import { FakeAlertAdapter } from '../adapters/alerts';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryCustomerCommunicationRepo } from '../db/customerCommunicationRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { runWatchdog } from './watchdog';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const bookingInput: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo', to: 'Kandy', vehicleType: 'car', adults: 1, children: 0, bags: 1,
    customer: {
      firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com',
      whatsapp: '+34600000000', country: 'Spain',
    },
  },
  total: 10000, amountDueNow: 10000, currency: 'USD',
};

describe('watchdog booking-tracking reconciliation', () => {
  it('raises explicit, dedupe-keyed alerts for each finding', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(bookingInput);
    const payment = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: booking.total, currency: booking.currency, idempotencyKey: `checkout:${booking.id}`,
    });
    await payments.markSucceededManually(payment.id, { reference: 'BANK-1', settledBy: 'f@x.com' });
    const communication = await communications.plan({
      bookingId: booking.id, kind: 'confirmation', channel: 'email',
      templateKey: 'booking-confirmation', templateVersion: '1', recipient: 'maya@example.com',
      source: 'payment_webhook', actorType: 'provider', actorId: null, requestId: null, runId: null,
      trackingKey: `${booking.id}:confirmation`, payloadSha256: 'a'.repeat(64),
    });
    await communications.recordEvent({
      communicationId: communication.id, eventType: 'send_attempted', providerEventId: null,
      providerMessageId: null, reasonCode: null, detailJson: null,
      occurredAt: new Date(NOW.getTime() - 2 * 60_000),
    });
    await communications.recordProviderEvent({
      communicationId: null, eventType: 'bounced', providerEventId: 'orphan-1',
      providerMessageId: 'unknown-message', reasonCode: 'hard_bounce', detailJson: null,
      occurredAt: NOW,
    });
    const alerts = new FakeAlertAdapter();
    const result = await runWatchdog(NOW, {
      bookings, payments, customerCommunications: communications,
      log: new InMemoryNotificationLogRepo(), alerts,
    });

    // The unlinked bounce is NOT a finding: the Resend webhook already alerted it on arrival.
    expect(result.trackingFindings).toBe(2);
    expect(alerts.sent.map((alert) => alert.kind).sort()).toEqual([
      'tracking_email_attempt_unresolved',
      'tracking_payment_transition_missing',
    ]);
    expect(alerts.sent.every((alert) => !!alert.dedupeKey)).toBe(true);
    expect(JSON.stringify(alerts.sent)).not.toContain('maya@example.com');
  });

  it('does not feed on its own mail: untracked emails\' Resend events raise no alerts', async () => {
    // Ops alerts, the digest and board mail go out untracked, so the Resend webhook stores their
    // sent/delivered events with no communication. When those were findings, every alert email
    // minted two more orphans, each alerted on the next sweep — and so on, every 30 minutes.
    const communications = new InMemoryCustomerCommunicationRepo();
    let message = 0;
    const resendEventsFor = async (at: Date) => {
      const id = `untracked-${++message}`;
      for (const eventType of ['provider_sent', 'delivered'] as const) {
        await communications.recordProviderEvent({
          communicationId: null, eventType, providerEventId: `${id}:${eventType}`,
          providerMessageId: id, reasonCode: null, detailJson: null, occurredAt: at,
        });
      }
    };
    // Every alert this watchdog sends is itself an untracked email.
    const alerts = new FakeAlertAdapter();
    const send = alerts.send.bind(alerts);
    alerts.send = async (alert) => { await send(alert); await resendEventsFor(NOW); };

    await resendEventsFor(NOW); // one untracked email (say, yesterday's digest) to start it off
    const deps = {
      bookings: new InMemoryBookingRepo(), payments: new InMemoryPaymentRepo(),
      customerCommunications: communications, log: new InMemoryNotificationLogRepo(), alerts,
    };
    await runWatchdog(NOW, deps);
    await runWatchdog(new Date(NOW.getTime() + 31 * 60_000), deps);

    expect(alerts.sent).toEqual([]);
  });
});
