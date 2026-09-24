import { describe, it, expect } from 'vitest';
import { buildDigest } from './digest';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';

const booking: NewBooking = {
  mode: 'single',
  input: { from: 'CMB', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
    customer: { firstName: 'A', lastName: 'B', email: 'a@b.com', whatsapp: '+94', country: 'LK' } },
  total: 6690, amountDueNow: 6690, currency: 'USD',
};

describe('buildDigest', () => {
  it('reports value booked and a quote snapshot, and humanizes alert labels', async () => {
    const bookings = new InMemoryBookingRepo();
    await bookings.create(booking);
    await bookings.create(booking);
    const quotes = new InMemoryQuoteRepo();
    await quotes.save({ channel: 'ops', product: 'private', totalCents: 1000, currency: 'USD', rateCardVersion: 'v1', request: {}, result: {} });
    const alertLog = { countsSince: async () => ({ watchdog_stuck_pending: 1 }), lastSentAt: async () => null };
    const d = await buildDigest(new Date(), { bookings, quotes, alertLog: alertLog as never });
    expect(d.text).toContain('Value booked (24h): $133.80'); // 2 × $66.90
    expect(d.text).toContain('Quotes created (24h): 1');
    expect(d.text).toContain('Payments stuck in pending: 1'); // humanized, not watchdog_stuck_pending
    expect(d.html).toContain('Ceylon Hop ops'); // rendered through the shell, not a <pre> dump
  });

  it('omits the quote section when no quotes repo is provided', async () => {
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo() });
    expect(d.text).not.toContain('Quotes created');
  });

  it('does not count unpriced shells towards Quotes created', async () => {
    const bookings = new InMemoryBookingRepo();
    const quotes = new InMemoryQuoteRepo();
    await quotes.save({ channel: 'ops', product: 'private', totalCents: 1000, currency: 'USD', rateCardVersion: 'v1', request: {}, result: {} });
    await quotes.save({ channel: 'ops', product: 'private', totalCents: 0, currency: 'USD', rateCardVersion: 'v1', request: { shell: true }, result: { shell: true } });
    const d = await buildDigest(new Date(), { bookings, quotes });
    expect(d.text).toContain('Quotes created (24h): 1'); // the shell is excluded, only the real quote counts
  });
});

// The watchdog's own heartbeat lives in the alert ledger (CH-V43ZU, 2026-09-24). The digest
// reads it as a fact about the monitor, never as an alert that fired.
describe('buildDigest — watchdog heartbeat', () => {
  it('shows when the watchdog last ran and never lists the tick as an alert', async () => {
    const alertLog = { countsSince: async () => ({ watchdog_tick: 1 }), lastSentAt: async () => new Date('2026-09-24T05:45:00Z') };
    const d = await buildDigest(new Date('2026-09-24T06:00:00Z'), { bookings: new InMemoryBookingRepo(), alertLog: alertLog as never });
    expect(d.text).not.toContain('watchdog_tick');
    expect(d.text).toContain('Alerts fired (24h): none');
    expect(d.text).toContain('Watchdog last ran: 15 min ago');
  });

  it('says never when no tick was ever recorded', async () => {
    const alertLog = { countsSince: async () => ({}), lastSentAt: async () => null };
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo(), alertLog: alertLog as never });
    expect(d.text).toContain('Watchdog last ran: never');
  });
});
