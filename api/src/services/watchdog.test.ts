import { describe, it, expect } from 'vitest';
import { runWatchdog } from './watchdog';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { FakeEmailAdapter } from '../adapters/email';

const sample: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo Airport',
    to: 'Ella',
    vehicleType: 'car',
    adults: 2,
    children: 0,
    bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000,
  amountDueNow: 5000,
  currency: 'USD',
};

// Bookings are created "now"; the sweep time-travels forward instead of back-dating rows.
const MIN = 60_000;
const later = (min: number) => new Date(Date.now() + min * MIN);

async function seed(status: 'payment_pending' | 'paid') {
  const bookings = new InMemoryBookingRepo();
  const b = await bookings.create(sample);
  await bookings.setStatus(b.id, 'payment_pending');
  if (status === 'paid') await bookings.setStatus(b.id, 'paid');
  return { bookings, booking: b };
}

describe('runWatchdog', () => {
  it('ignores a fresh payment_pending booking', async () => {
    const { bookings } = await seed('payment_pending');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(5), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.stuckPending).toBe(0);
    expect(alerts.sent).toHaveLength(0);
  });

  it('alerts on a payment_pending booking older than 30 minutes', async () => {
    const { bookings, booking } = await seed('payment_pending');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(31), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.stuckPending).toBe(1);
    expect(alerts.sent[0].kind).toBe('watchdog_stuck_pending');
    expect(alerts.sent[0].body).toContain(booking.reference);
  });

  it('alerts on a paid booking with no confirmation logged after 15 minutes', async () => {
    const { bookings, booking } = await seed('paid');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(16), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.paidUnconfirmed).toBe(1);
    expect(alerts.sent[0].kind).toBe('watchdog_paid_unconfirmed');
    expect(alerts.sent[0].body).toContain(booking.reference);
  });

  it('stays quiet when the confirmation was sent', async () => {
    const { bookings, booking } = await seed('paid');
    const log = new InMemoryNotificationLogRepo();
    await log.markSent(booking.id, 'confirmation');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(60), { bookings, log, alerts });
    expect(res.paidUnconfirmed).toBe(0);
    expect(alerts.sent).toHaveLength(0);
  });

  it('a persisting problem alerts once per cooldown across repeated sweeps (dedupe by booking)', async () => {
    const { bookings } = await seed('payment_pending');
    const inner = new FakeAlertAdapter();
    const alerts = new ThrottledAlerts(inner, new InMemoryAlertLogRepo());
    const deps = { bookings, log: new InMemoryNotificationLogRepo(), alerts };
    const r1 = await runWatchdog(later(31), deps);
    const r2 = await runWatchdog(later(46), deps); // 15 min later — inside the 30-min cooldown
    expect(r1.stuckPending).toBe(1);
    expect(r2.stuckPending).toBe(1); // still counted as stuck…
    expect(inner.sent).toHaveLength(1); // …but the founder got exactly one email
  });
});

  it('emails the customer a one-shot recovery when email deps are provided', async () => {
    const { bookings, booking } = await seed('payment_pending');
    const alerts = new FakeAlertAdapter();
    const log = new InMemoryNotificationLogRepo();
    const email = new FakeEmailAdapter();
    const deps = { bookings, log, alerts, email, baseUrl: 'https://ceylonhop.com', linkSecret: 'sek' };

    const res = await runWatchdog(later(31), deps);
    expect(res.recoveryEmails).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('maya@example.com');
    expect(email.sent[0].subject).toContain(booking.reference);
    expect(email.sent[0].html).toContain('manage.html');
    expect(await log.wasSent(booking.id, 'payment_recovery')).toBe(true);

    // A later sweep must NOT email again (idempotent).
    const res2 = await runWatchdog(later(45), deps);
    expect(res2.recoveryEmails).toBe(0);
    expect(email.sent).toHaveLength(1);
  });

  it('does not email when email deps are absent (alerts only)', async () => {
    const { bookings } = await seed('payment_pending');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(31), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.recoveryEmails).toBe(0);
  });
