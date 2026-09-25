import { describe, it, expect } from 'vitest';
import { buildDigest } from './digest';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryBookingCheckoutEventRepo, type CheckoutSummary } from '../db/bookingCheckoutEventRepo';

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

// Test bookings (2026-09-24): the owner's and team's own bookings must not inflate the digest's
// status counts — every "Payment pending" in the August digests was an owner test.
describe('buildDigest — team test bookings', () => {
  it('leaves a team-email booking out of the status counts', async () => {
    const bookings = new InMemoryBookingRepo();
    const real = await bookings.create(booking);
    await bookings.setStatus(real.id, 'payment_pending');
    const test = await bookings.create({
      ...booking,
      input: { ...booking.input, customer: { ...booking.input.customer, email: 'Owner@CeylonHop.com' } },
    });
    await bookings.setStatus(test.id, 'payment_pending');
    const d = await buildDigest(new Date(), { bookings, teamEmails: new Set(['owner@ceylonhop.com']) });
    expect(d.text).toContain('Payment pending: 1');
  });

  it('counts everything when no team set is given (inert by default)', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({
      ...booking,
      input: { ...booking.input, customer: { ...booking.input.customer, email: 'owner@ceylonhop.com' } },
    });
    await bookings.setStatus(b.id, 'payment_pending');
    const d = await buildDigest(new Date(), { bookings });
    expect(d.text).toContain('Payment pending: 1');
  });
});

// Payments early warning (2026-09-24): the founder sees website checkouts failing in the one
// daily email, read from booking_checkout_event (migration 0055), without running SQL.
describe('buildDigest — payments (24h)', () => {
  const summaryOf = (s: CheckoutSummary) => ({ summarySince: async () => s });
  const base: CheckoutSummary = { started: 0, paid: 0, declined: 0, cancelledAtGateway: 0, abandoned: 0, createRefused: 0 };

  it('renders the checkout funnel line from the attempt log', async () => {
    const checkoutEvents = summaryOf({ started: 5, paid: 3, declined: 1, cancelledAtGateway: 0, abandoned: 1, createRefused: 2 });
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo(), checkoutEvents: checkoutEvents as never });
    expect(d.text).toContain('Payments (24h)');
    expect(d.text).toContain('Checkouts started: 5 · paid 3 · declined 1 · cancelled at PayHere 0 · no answer 1 · booking errors 2');
    expect(d.html).toContain('Payments (24h)');
    expect(d.html).toContain('cancelled at PayHere 0');
    expect(d.text).not.toContain('⚠'); // 60% paid is not below the line
  });

  it('warns when at least 3 checkouts started and under 60% paid', async () => {
    const checkoutEvents = summaryOf({ ...base, started: 4, paid: 2, abandoned: 2 });
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo(), checkoutEvents: checkoutEvents as never });
    expect(d.text).toContain('⚠ Only 50% of checkouts paid in the last 24h — check booking_checkout_event');
    expect(d.html).toContain('Only 50% of checkouts paid');
  });

  it('does not warn on fewer than 3 checkouts, however they went', async () => {
    const checkoutEvents = summaryOf({ ...base, started: 2, declined: 2 });
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo(), checkoutEvents: checkoutEvents as never });
    expect(d.text).toContain('Checkouts started: 2');
    expect(d.text).not.toContain('⚠');
  });

  it('asks the log to leave the team’s test bookings out', async () => {
    const bookings = new InMemoryBookingRepo();
    const real = await bookings.create(booking);
    const test = await bookings.create({
      ...booking,
      input: { ...booking.input, customer: { ...booking.input.customer, email: 'owner@ceylonhop.com' } },
    });
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    for (const b of [real, test]) {
      await checkoutEvents.record({ action: 'checkout', outcome: 'succeeded', bookingId: b.id, source: 'server' });
      await checkoutEvents.record({ action: 'webhook', outcome: 'settled', bookingId: b.id, source: 'server' });
    }
    const d = await buildDigest(new Date(Date.now() + 1000), { bookings, checkoutEvents, teamEmails: new Set(['owner@ceylonhop.com']) });
    expect(d.text).toContain('Checkouts started: 1 · paid 1');
  });

  it('omits the section when no checkout log is wired', async () => {
    const d = await buildDigest(new Date(), { bookings: new InMemoryBookingRepo() });
    expect(d.text).not.toContain('Payments (24h)');
    expect(d.text).not.toContain('Checkouts started');
    expect(d.html).not.toContain('Payments (24h)');
  });
});
