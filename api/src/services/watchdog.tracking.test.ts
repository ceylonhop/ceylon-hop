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

    expect(result.trackingFindings).toBe(3);
    expect(alerts.sent.map((alert) => alert.kind).sort()).toEqual([
      'tracking_email_attempt_unresolved',
      'tracking_payment_transition_missing',
      'tracking_provider_event_orphan',
    ]);
    expect(alerts.sent.every((alert) => !!alert.dedupeKey)).toBe(true);
    expect(JSON.stringify(alerts.sent)).not.toContain('maya@example.com');
  });
});
