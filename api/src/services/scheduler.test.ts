import { describe, it, expect } from 'vitest';
import { runScheduledNotifications, sweepStaleSharedHolds } from './scheduler';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { FakeEmailAdapter } from '../adapters/email';

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const NOW = new Date('2026-07-01T08:00:00'); // local — matches how travelAt builds dates

async function paidSingle(bookings: InMemoryBookingRepo, date: string, time = '09:00') {
  const b = await bookings.create({
    mode: 'single',
    input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0, date, time, customer },
    total: 5000,
    amountDueNow: 5000,
    currency: 'USD',
  });
  await bookings.setStatus(b.id, 'payment_pending');
  await bookings.setStatus(b.id, 'paid');
  return b;
}

async function paidTrip(bookings: InMemoryBookingRepo, dates: string[]) {
  const b = await bookings.create({
    mode: 'trip',
    input: {
      stops: ['Colombo Airport', 'Kandy', 'Ella'],
      nights: [1, 2, 0],
      dates,
      pax: 2,
      vehicleType: 'van',
      serviceType: 'private',
      customer,
    },
    total: 20000,
    amountDueNow: 20000,
    currency: 'USD',
  });
  await bookings.setStatus(b.id, 'payment_pending');
  await bookings.setStatus(b.id, 'paid');
  return b;
}

function deps() {
  return {
    bookings: new InMemoryBookingRepo(),
    log: new InMemoryNotificationLogRepo(),
    email: new FakeEmailAdapter(),
    baseUrl: 'https://ceylonhop.com',
    linkSecret: 'test-link-secret',
  };
}

describe('runScheduledNotifications — pre-trip reminder', () => {
  it('reminds a paid booking departing within 48h, exactly once across ticks', async () => {
    const d = deps();
    await paidSingle(d.bookings, '2026-07-02'); // ~25h out
    const r1 = await runScheduledNotifications(NOW, d);
    expect(r1.reminders).toBe(1);
    expect(d.email.sent.filter((m) => /coming up/i.test(m.subject))).toHaveLength(1);

    const r2 = await runScheduledNotifications(NOW, d); // tick again → idempotent
    expect(r2.reminders).toBe(0);
    expect(d.email.sent.filter((m) => /coming up/i.test(m.subject))).toHaveLength(1);
  });

  it('does not remind a booking departing far in the future', async () => {
    const d = deps();
    await paidSingle(d.bookings, '2026-07-10'); // 9 days out
    expect((await runScheduledNotifications(NOW, d)).reminders).toBe(0);
  });

  it('does not remind a cancelled booking', async () => {
    const d = deps();
    const b = await paidSingle(d.bookings, '2026-07-02');
    await d.bookings.setStatus(b.id, 'cancelled');
    expect((await runScheduledNotifications(NOW, d)).reminders).toBe(0);
  });

  it('reminds a CONFIRMED booking within 48h (not only paid)', async () => {
    const d = deps();
    const b = await paidSingle(d.bookings, '2026-07-02');
    await d.bookings.setStatus(b.id, 'confirmed');
    expect((await runScheduledNotifications(NOW, d)).reminders).toBe(1);
  });

  it('skips a booking with no travel date (flexible) — no reminder, no review', async () => {
    const d = deps();
    const b = await d.bookings.create({
      mode: 'single',
      input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0, customer },
      total: 5000,
      amountDueNow: 5000,
      currency: 'USD',
    });
    await d.bookings.setStatus(b.id, 'payment_pending');
    await d.bookings.setStatus(b.id, 'paid');
    const r = await runScheduledNotifications(NOW, d);
    expect(r.reminders).toBe(0);
    expect(r.reviews).toBe(0);
  });

  it('does NOT mark sent when the email fails, so the next tick retries', async () => {
    const bookings = new InMemoryBookingRepo();
    const log = new InMemoryNotificationLogRepo();
    let calls = 0;
    const flaky = { send: async () => { calls++; if (calls === 1) throw new Error('provider down'); } };
    await paidSingle(bookings, '2026-07-02');
    const r1 = await runScheduledNotifications(NOW, { bookings, log, email: flaky, baseUrl: 'https://ceylonhop.com', linkSecret: 'test-link-secret' });
    expect(r1.reminders).toBe(0); // send threw → swallowed, NOT counted, NOT marked
    const r2 = await runScheduledNotifications(NOW, { bookings, log, email: flaky, baseUrl: 'https://ceylonhop.com', linkSecret: 'test-link-secret' });
    expect(r2.reminders).toBe(1); // retried on the next tick and succeeded
  });
});

describe('runScheduledNotifications — review request', () => {
  it('asks for a review after travel has passed, exactly once', async () => {
    const d = deps();
    await paidSingle(d.bookings, '2026-06-29'); // 2 days ago
    const r1 = await runScheduledNotifications(NOW, d);
    expect(r1.reviews).toBe(1);
    expect(d.email.sent.filter((m) => /how was your trip/i.test(m.subject))).toHaveLength(1);

    const r2 = await runScheduledNotifications(NOW, d);
    expect(r2.reviews).toBe(0);
  });

  it('does not ask a booking that has not travelled yet', async () => {
    const d = deps();
    await paidSingle(d.bookings, '2026-07-02'); // future
    expect((await runScheduledNotifications(NOW, d)).reviews).toBe(0);
  });

  // Wait a full day after the trip before asking — a few hours on, we can't be sure the
  // customer has actually finished travelling. NOW is 2026-07-01T08:00.
  it('waits a full day (24h) after the trip ends before asking for a review', async () => {
    const soon = deps();
    await paidSingle(soon.bookings, '2026-06-30', '12:00'); // ended 20h ago — too soon
    expect((await runScheduledNotifications(NOW, soon)).reviews).toBe(0);

    const dayOn = deps();
    await paidSingle(dayOn.bookings, '2026-06-30', '06:00'); // ended 26h ago — a full day on
    expect((await runScheduledNotifications(NOW, dayOn)).reviews).toBe(1);
  });

  // BI6 — a multi-day trip anchors its review to the LAST leg, not the first, so the
  // customer isn't asked "how was your trip?" while still on day one.
  it('does NOT ask for a review while a multi-day trip is still ongoing', async () => {
    const d = deps();
    await paidTrip(d.bookings, ['2026-06-29', '2026-07-05']); // started 2 days ago, ends in the future
    expect((await runScheduledNotifications(NOW, d)).reviews).toBe(0);
  });

  it('asks once the whole multi-day trip is over', async () => {
    const d = deps();
    await paidTrip(d.bookings, ['2026-06-25', '2026-06-29']); // last leg 2 days ago
    expect((await runScheduledNotifications(NOW, d)).reviews).toBe(1);
  });
});

// GL-3 — abandoned shared checkouts must give their held seats back after 24h.
describe('sweepStaleSharedHolds', () => {
  const DEPARTURE = { corridorId: 'hill-line', date: '2026-07-20', time: '08:00' } as const;

  async function heldShared(bookings: InMemoryBookingRepo, departures: InMemoryDepartureRepo, seats: number) {
    await departures.holdSeats({ ...DEPARTURE, seats });
    return bookings.create({
      mode: 'shared',
      input: { ...DEPARTURE, seats, customer },
      total: seats * 2100,
      amountDueNow: seats * 2100,
      currency: 'USD',
    });
  }

  const hoursFromNow = (h: number) => new Date(Date.now() + h * 3600 * 1000);

  it('cancels a >24h-old shared draft and frees its seats', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const b = await heldShared(bookings, departures, 12); // the whole bus

    const r = await sweepStaleSharedHolds({ bookings, departures, now: hoursFromNow(25) });
    expect(r.swept).toBe(1);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    // seats are back: the full bus can be held again
    expect(await departures.holdSeats({ ...DEPARTURE, seats: 12 })).not.toBeNull();
  });

  it('sweeps a stale payment_pending hold too (checkout started, never paid)', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const b = await heldShared(bookings, departures, 12);
    await bookings.setStatus(b.id, 'payment_pending');

    const r = await sweepStaleSharedHolds({ bookings, departures, now: hoursFromNow(25) });
    expect(r.swept).toBe(1);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    expect(await departures.holdSeats({ ...DEPARTURE, seats: 12 })).not.toBeNull();
  });

  it('leaves a fresh hold alone (2h old)', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const b = await heldShared(bookings, departures, 12);

    const r = await sweepStaleSharedHolds({ bookings, departures, now: hoursFromNow(2) });
    expect(r.swept).toBe(0);
    expect((await bookings.get(b.id))!.status).toBe('draft');
    expect(await departures.holdSeats({ ...DEPARTURE, seats: 1 })).toBeNull(); // still full
  });

  it('never touches non-shared drafts, however old', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const b = await bookings.create({
      mode: 'single',
      input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 1, children: 0, bags: 0, customer },
      total: 5000,
      amountDueNow: 5000,
      currency: 'USD',
    });

    const r = await sweepStaleSharedHolds({ bookings, departures, now: hoursFromNow(48) });
    expect(r.swept).toBe(0);
    expect((await bookings.get(b.id))!.status).toBe('draft');
  });
});
