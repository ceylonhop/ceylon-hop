import { describe, it, expect } from 'vitest';
import { runScheduledNotifications } from './scheduler';
import { InMemoryBookingRepo } from '../db/bookingRepo';
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

function deps() {
  return { bookings: new InMemoryBookingRepo(), log: new InMemoryNotificationLogRepo(), email: new FakeEmailAdapter() };
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
    const r1 = await runScheduledNotifications(NOW, { bookings, log, email: flaky });
    expect(r1.reminders).toBe(0); // send threw → swallowed, NOT counted, NOT marked
    const r2 = await runScheduledNotifications(NOW, { bookings, log, email: flaky });
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
});
