import { describe, it, expect, afterEach, vi } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryQuoteRepo, type NewQuote } from './quoteRepo';
import { InMemoryNotificationLogRepo } from './notificationLogRepo';
import { InMemoryBookingCheckoutEventRepo } from './bookingCheckoutEventRepo';
import { InMemoryPaymentRepo } from './paymentRepo';

// The read-only lookups behind the ops payment lookup page (spec 2026-09-26 §7). Each one reads a
// row the page needs and nothing writes through them.

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single: NewBooking = {
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
  total: 5000, amountDueNow: 5000, currency: 'USD',
};
const quote = (over: Partial<NewQuote> = {}): NewQuote => ({
  product: 'private', vehicle: 'car', customerName: 'Maya', customerContact: '+34600',
  totalCents: 4048, currency: 'USD', rateCardVersion: '2026-06-28', marginCents: 900,
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
  result: { totalCents: 4048 },
  ...over,
});

afterEach(() => { vi.useRealTimers(); });

describe('BookingRepo.findByReference (in-memory)', () => {
  it('finds a booking by its reference, and nothing for an unknown one', async () => {
    const repo = new InMemoryBookingRepo();
    const b = await repo.create(single);
    await repo.create(single);
    expect((await repo.findByReference(b.reference))?.id).toBe(b.id);
    expect(await repo.findByReference('CH-NOPE2')).toBeNull();
  });
});

describe('QuoteRepo.findByReference (in-memory)', () => {
  it('finds a quote by its reference, never a soft-deleted one', async () => {
    const repo = new InMemoryQuoteRepo();
    const q = await repo.save(quote());
    expect((await repo.findByReference(q.reference))?.id).toBe(q.id);
    await repo.softDelete(q.id, 'f@x.com');
    expect(await repo.findByReference(q.reference)).toBeNull();
    expect(await repo.findByReference('Q-NOPE2')).toBeNull();
  });
});

describe('NotificationLogRepo.listByBookingId (in-memory)', () => {
  it('lists each email kind sent for the booking with its time, oldest first', async () => {
    vi.useFakeTimers();
    const log = new InMemoryNotificationLogRepo();
    vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
    await log.markSent('b1', 'payment_failed');
    vi.setSystemTime(new Date('2026-09-26T10:05:00Z'));
    expect(await log.claim('b1', 'payment_recovery')).toBe(true);
    await log.markSent('b2', 'confirmation');
    expect(await log.listByBookingId('b1')).toEqual([
      { kind: 'payment_failed', sentAt: new Date('2026-09-26T10:00:00Z') },
      { kind: 'payment_recovery', sentAt: new Date('2026-09-26T10:05:00Z') },
    ]);
  });

  it('keeps the first send time, and forgets a released claim', async () => {
    vi.useFakeTimers();
    const log = new InMemoryNotificationLogRepo();
    vi.setSystemTime(new Date('2026-09-26T10:00:00Z'));
    await log.markSent('b1', 'confirmation');
    vi.setSystemTime(new Date('2026-09-26T11:00:00Z'));
    await log.markSent('b1', 'confirmation');
    await log.claim('b1', 'payment_recovery');
    await log.release('b1', 'payment_recovery');
    expect(await log.listByBookingId('b1')).toEqual([{ kind: 'confirmation', sentAt: new Date('2026-09-26T10:00:00Z') }]);
    expect(await log.wasSent('b1', 'confirmation')).toBe(true);
  });
});

describe('BookingCheckoutEventRepo.listByOrderId (in-memory)', () => {
  it('lists the rows carrying the order id, newest first', async () => {
    const log = new InMemoryBookingCheckoutEventRepo();
    await log.record({ action: 'webhook', outcome: 'refused', source: 'server', orderId: 'CH-AAAA2', reason: 'signature_mismatch' }, new Date('2026-09-26T10:00:00Z'));
    await log.record({ action: 'checkout', outcome: 'succeeded', source: 'server', bookingId: 'b1', orderId: 'CH-AAAA2' }, new Date('2026-09-26T10:01:00Z'));
    await log.record({ action: 'webhook', outcome: 'refused', source: 'server', orderId: 'CH-BBBB2' }, new Date('2026-09-26T10:02:00Z'));
    const rows = await log.listByOrderId!('CH-AAAA2');
    expect(rows.map((r) => r.action)).toEqual(['checkout', 'webhook']);
    expect(rows[1]).toMatchObject({ orderId: 'CH-AAAA2', bookingId: null, reason: 'signature_mismatch' });
  });
});

describe('PaymentRepo.provenanceFor (in-memory)', () => {
  it('reports how a payment row came to be and how it settled', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-26T09:00:00Z'));
    const repo = new InMemoryPaymentRepo();
    const gateway = await repo.create({ bookingId: 'b1', provider: 'payhere', orderId: 'CH-AAAA2', amount: 5000, currency: 'USD', idempotencyKey: 'checkout:b1' });
    expect(await repo.provenanceFor(gateway.id)).toEqual({
      createdAt: new Date('2026-09-26T09:00:00Z'), settledAt: null, settlementSource: null, settledBy: null, gatewayPaymentId: null,
    });

    vi.setSystemTime(new Date('2026-09-26T09:30:00Z'));
    const manual = await repo.create({ bookingId: 'b1', provider: 'cash', orderId: 'CH-AAAA2-MANUAL', amount: 5000, currency: 'USD', idempotencyKey: 'manual-paid:b1' });
    await repo.markSucceededManually(manual.id, { reference: 'SLIP-7', settledBy: 'f@x.com' });
    expect(await repo.provenanceFor(manual.id)).toMatchObject({
      createdAt: new Date('2026-09-26T09:30:00Z'), settlementSource: 'manual', settledBy: 'f@x.com', gatewayPaymentId: 'SLIP-7',
    });
    expect((await repo.provenanceFor(manual.id))?.settledAt).toBeInstanceOf(Date);
    expect(await repo.provenanceFor('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
