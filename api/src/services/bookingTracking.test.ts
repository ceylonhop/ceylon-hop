import { describe, expect, it } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import {
  InMemoryCustomerCommunicationRepo,
  type CustomerCommunicationRepo,
} from '../db/customerCommunicationRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { loadBookingTracking, reconcileBookingTracking } from './bookingTracking';

const NOW = new Date('2026-09-27T12:00:00.000Z');
const customer = {
  firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com',
  whatsapp: '+34600000000', country: 'Spain',
};
const draft: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo', to: 'Kandy', vehicleType: 'car', adults: 1, children: 0, bags: 1,
    date: '2030-01-15', time: '09:00', customer,
  },
  total: 10000, amountDueNow: 10000, currency: 'USD',
};

describe('loadBookingTracking', () => {
  it('merges transition and communication facts deterministically, masks PII and paginates', async () => {
    const bookings = new InMemoryBookingRepo({ transitionTrackingEnabled: true, now: () => NOW });
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(draft);
    await bookings.setStatus(booking.id, 'payment_pending', undefined, {
      source: 'website', actorType: 'customer', requestId: '11111111-1111-4111-8111-111111111111',
    });
    const communication = await communications.plan({
      bookingId: booking.id,
      kind: 'confirmation',
      channel: 'email',
      templateKey: 'booking-confirmation',
      templateVersion: '1',
      recipient: 'maya@example.com',
      source: 'payment_webhook',
      actorType: 'provider',
      actorId: null,
      requestId: null,
      runId: null,
      trackingKey: `${booking.id}:confirmation`,
      payloadSha256: 'a'.repeat(64),
    });
    await communications.recordEvent({
      communicationId: communication.id,
      eventType: 'provider_accepted',
      providerEventId: null,
      providerMessageId: 'email-1',
      reasonCode: null,
      detailJson: null,
      occurredAt: NOW,
    });
    await communications.recordEvent({
      communicationId: communication.id,
      eventType: 'delivered',
      providerEventId: 'evt-1',
      providerMessageId: 'email-1',
      reasonCode: null,
      detailJson: null,
      occurredAt: new Date(NOW.getTime() + 1000),
    });

    const first = await loadBookingTracking({ bookings, communications }, booking, { limit: 2 });
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toEqual(expect.any(String));
    expect(first.items[0]).toMatchObject({ source: 'communication', eventType: 'delivered', recipient: 'm***@example.com' });
    expect(JSON.stringify(first)).not.toContain('maya@example.com');
    expect(JSON.stringify(first)).not.toContain('11111111-1111-4111-8111-111111111111');
    expect(JSON.stringify(first)).not.toContain('email-1');

    const second = await loadBookingTracking(
      { bookings, communications }, booking,
      { limit: 2, cursor: first.nextCursor! },
    );
    expect(second.items).toHaveLength(1);
    expect(second.items[0]).toMatchObject({ source: 'booking_transition', fromStatus: 'draft', toStatus: 'payment_pending' });
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((item) => item.id)).size).toBe(3);
  });

  it('labels a legacy booking as partial history instead of claiming nothing happened', async () => {
    const bookings = new InMemoryBookingRepo();
    const booking = await bookings.create(draft);
    const response = await loadBookingTracking(
      { bookings, communications: new InMemoryCustomerCommunicationRepo() },
      { ...booking, createdAt: '2026-09-01T00:00:00.000Z' },
      { limit: 20 },
    );
    expect(response.items).toEqual([]);
    expect(response.historyAvailableSince).toEqual({
      bookingTransitions: '2026-09-26T00:00:00.000Z',
      customerCommunications: '2026-09-26T00:00:00.000Z',
    });
    expect(response.partialHistory).toBe(true);
    expect(response.unavailableSources).toEqual([]);
  });

  it('returns the healthy source and names the failed source', async () => {
    const bookings = new InMemoryBookingRepo();
    const booking = await bookings.create(draft);
    const broken = new InMemoryCustomerCommunicationRepo();
    broken.listByBookingId = async () => { throw new Error('communications down'); };
    const response = await loadBookingTracking({ bookings, communications: broken }, booking, { limit: 20 });
    expect(response.items).toEqual([]);
    expect(response.unavailableSources).toEqual(['customer_communications']);
  });

  it('shows successful, suppressed, failed, bounced, cancellation and refund evidence together', async () => {
    const bookings = new InMemoryBookingRepo({ transitionTrackingEnabled: true, now: () => NOW });
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(draft);
    await bookings.setStatus(booking.id, 'payment_pending', undefined, {
      source: 'website', actorType: 'customer',
    });
    await bookings.setStatus(booking.id, 'paid', undefined, {
      source: 'payment_webhook', actorType: 'provider',
      relatedEntityType: 'payment', relatedEntityId: 'payment-1',
    });
    await bookings.setStatus(booking.id, 'cancelled', { reason: 'customer asked', by: 'ops', at: NOW }, {
      source: 'ops', actorType: 'staff', actorId: 'ops',
    });
    await bookings.setStatus(booking.id, 'refunded', undefined, {
      source: 'refund', actorType: 'staff', actorId: 'ops',
      relatedEntityType: 'refund', relatedEntityId: 'refund-1',
    });

    const scenarios = [
      ['confirmation', 'provider_accepted'],
      ['details_needed', 'suppressed'],
      ['payment_failed', 'send_failed'],
      ['cancellation', 'bounced'],
      ['refund', 'delivered'],
    ] as const;
    for (const [kind, eventType] of scenarios) {
      const communication = await communications.plan({
        bookingId: booking.id, kind, channel: 'email', templateKey: kind, templateVersion: '1',
        recipient: customer.email, source: 'ops', actorType: 'staff', actorId: null,
        requestId: null, runId: null, trackingKey: `${booking.id}:${kind}`, payloadSha256: 'c'.repeat(64),
      });
      await communications.recordEvent({
        communicationId: communication.id, eventType, providerEventId: null,
        providerMessageId: eventType === 'suppressed' || eventType === 'send_failed' ? null : `${kind}-1`,
        reasonCode: eventType === 'suppressed' ? 'kill_switch' : eventType === 'send_failed' ? 'adapter_error' : null,
        detailJson: null, occurredAt: NOW,
      });
    }

    const response = await loadBookingTracking({ bookings, communications }, booking, { limit: 100 });
    const communicationEvents = response.items
      .filter((item) => item.source === 'communication')
      .map((item) => [item.communicationKind, item.eventType]);
    expect(communicationEvents).toEqual(expect.arrayContaining(scenarios.map((row) => [...row])));
    expect(response.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: 'booking_transition', toStatus: 'cancelled' }),
      expect.objectContaining({ source: 'booking_transition', toStatus: 'refunded' }),
    ]));
  });
});

describe('reconcileBookingTracking', () => {
  it('finds every Phase A invariant without inventing missing delivery alerts', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(draft);
    bookings.listStatusEventMismatches = async () => [{
      bookingId: booking.id, currentStatus: 'cancelled', eventStatus: 'payment_pending',
    }];
    const payment = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: booking.total, currency: booking.currency, idempotencyKey: `checkout:${booking.id}`,
    });
    await payments.markSucceededManually(payment.id, { reference: 'BANK-1', settledBy: 'f@x.com' });

    const communication = await communications.plan({
      bookingId: booking.id, kind: 'confirmation', channel: 'email',
      templateKey: 'booking-confirmation', templateVersion: '1', recipient: customer.email,
      source: 'payment_webhook', actorType: 'provider', actorId: null, requestId: null, runId: null,
      trackingKey: `${booking.id}:confirmation`, payloadSha256: 'b'.repeat(64),
    });
    await communications.recordEvent({
      communicationId: communication.id, eventType: 'send_attempted', providerEventId: null,
      providerMessageId: null, reasonCode: null, detailJson: null,
      occurredAt: new Date(NOW.getTime() - 10 * 60_000),
    });
    await communications.recordProviderEvent({
      communicationId: null, eventType: 'bounced', providerEventId: 'orphan-1',
      providerMessageId: 'unknown-message', reasonCode: 'hard_bounce', detailJson: null,
      occurredAt: NOW,
    });
    await communications.recordProviderEvent({
      communicationId: communication.id, eventType: 'provider_failed', providerEventId: 'failed-1',
      providerMessageId: 'email-1', reasonCode: 'rejected', detailJson: null,
      occurredAt: NOW,
    });
    const findings = await reconcileBookingTracking(NOW, { bookings, payments, communications });
    expect(findings.unavailableSources).toEqual([]);
    expect(findings.findings.map((finding) => finding.kind).sort()).toEqual([
      'booking_status_mismatch',
      'captured_payment_missing_transition',
      'communication_attempt_unresolved',
      'orphan_provider_event',
      'provider_communication_failure',
    ]);
    expect(findings.findings).not.toContainEqual(expect.objectContaining({ kind: 'delivery_missing' }));
  });

  it('keeps partial findings and reports a failed reconciliation source', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(draft);
    bookings.listStatusEventMismatches = async () => { throw new Error('status ledger down'); };
    const brokenCommunications = communications as CustomerCommunicationRepo;
    brokenCommunications.listReconciliationFindings = async () => { throw new Error('comms down'); };
    const result = await reconcileBookingTracking(NOW, { bookings, payments, communications: brokenCommunications });
    expect(result.findings).toEqual([]);
    expect(result.unavailableSources).toEqual(['booking_status_events', 'customer_communications']);
    expect(booking.id).toBeTruthy();
  });

  // Deposits (spec 2026-10-07 §5.1): the deposit moves the booking to paid; the balance never does.
  it('does not ask for a paid transition on a succeeded balance payment, but still does for a full one', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const booking = await bookings.create(draft);
    const balance = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: `${booking.reference}-B`,
      amount: 1_000, currency: booking.currency, idempotencyKey: `checkout:${booking.id}:balance`, purpose: 'balance',
    });
    await payments.markSucceededManually(balance.id, { reference: 'BAL-1', settledBy: 'f@x.com' });
    const full = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: booking.total, currency: booking.currency, idempotencyKey: `checkout:${booking.id}`,
    });
    await payments.markSucceededManually(full.id, { reference: 'FULL-1', settledBy: 'f@x.com' });

    const result = await reconcileBookingTracking(NOW, {
      bookings, payments, communications: new InMemoryCustomerCommunicationRepo(),
    });

    const missing = result.findings.filter((f) => f.kind === 'captured_payment_missing_transition');
    expect(missing).toEqual([expect.objectContaining({ paymentId: full.id })]);
  });

  it('an abandoned pending attempt is history, not a finding', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const booking = await bookings.create(draft);
    await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: booking.total, currency: booking.currency, idempotencyKey: `checkout:${booking.id}`,
    }); // the full attempt the customer walked away from — stays pending
    const result = await reconcileBookingTracking(NOW, {
      bookings, payments, communications: new InMemoryCustomerCommunicationRepo(),
    });
    expect(result.findings).toEqual([]);
  });

  it('does not call a pre-ledger captured payment inconsistent', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const booking = await bookings.create(draft);
    const payment = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: booking.total, currency: booking.currency, idempotencyKey: `legacy:${booking.id}`,
    });
    await payments.markSucceededManually(payment.id, { reference: 'OLD-1', settledBy: 'f@x.com' });
    payments.provenanceFor = async () => ({
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      settledAt: new Date('2026-09-01T00:01:00.000Z'),
      settlementSource: 'legacy_backfill', settledBy: null, gatewayPaymentId: 'OLD-1',
    });
    const result = await reconcileBookingTracking(NOW, {
      bookings, payments, communications: new InMemoryCustomerCommunicationRepo(),
    });
    expect(result.findings).not.toContainEqual(expect.objectContaining({ kind: 'captured_payment_missing_transition' }));
  });

  it('reports one unresolved finding when one communication has multiple stale attempts', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const communications = new InMemoryCustomerCommunicationRepo();
    const booking = await bookings.create(draft);
    const communication = await communications.plan({
      bookingId: booking.id, kind: 'confirmation', channel: 'email',
      templateKey: 'booking-confirmation', templateVersion: '1', recipient: customer.email,
      source: 'payment_webhook', actorType: 'provider', actorId: null, requestId: null, runId: null,
      trackingKey: `${booking.id}:retry`, payloadSha256: 'd'.repeat(64),
    });
    for (const minutes of [5, 4]) {
      await communications.recordEvent({
        communicationId: communication.id, eventType: 'send_attempted', providerEventId: null,
        providerMessageId: null, reasonCode: null, detailJson: null,
        occurredAt: new Date(NOW.getTime() - minutes * 60_000),
      });
    }
    const result = await reconcileBookingTracking(NOW, { bookings, payments, communications });
    expect(result.findings.filter((finding) => finding.kind === 'communication_attempt_unresolved')).toHaveLength(1);
  });
});
