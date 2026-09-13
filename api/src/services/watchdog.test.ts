import { describe, it, expect } from 'vitest';
import { runWatchdog } from './watchdog';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryNotificationLogRepo, type NotificationKind } from '../db/notificationLogRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { FakeAlertAdapter, ThrottledAlerts } from '../adapters/alerts';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { SendBudget } from './sendBudget';

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


  // The exemption is about HOW the money arrived, not which channel booked it. That only
  // started mattering once ops could hand a WhatsApp customer a card link: a whatsapp-channel
  // booking paid at the gateway IS a genuine silent-confirmation failure, and a channel-keyed
  // exemption — the shape the stuck-pending sweep above uses — would quietly swallow it.
  it('still alerts a gateway-paid booking on the whatsapp channel', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, channel: 'whatsapp' });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const payments = new InMemoryPaymentRepo();
    const p = await payments.create({
      bookingId: b.id, provider: 'payhere', orderId: b.reference,
      amount: 5000, currency: 'USD', idempotencyKey: `checkout:${b.id}`,
    });
    await payments.markSucceeded(p.id);
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(16), { bookings, log: new InMemoryNotificationLogRepo(), alerts, payments });
    expect(res.paidUnconfirmed).toBe(1);
    expect(alerts.sent[0].kind).toBe('watchdog_paid_unconfirmed');
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

  // A cash/bank booking settled through POST /admin/bookings/:id/mark-paid deliberately sends no
  // confirmation email, and its status never leaves 'paid' (the pipeline advances on ride_ops).
  // Without an exemption it would page the founder on every sweep until departure.
  it('skips a booking settled out-of-band (manual payment) — no paid-unconfirmed alert', async () => {
    const { bookings, booking } = await seed('paid');
    const payments = new InMemoryPaymentRepo();
    const p = await payments.create({
      bookingId: booking.id, provider: 'cash', orderId: `${booking.reference}-MANUAL`,
      amount: 5000, currency: 'USD', idempotencyKey: `manual-paid:${booking.id}`,
    });
    await payments.markSucceededManually(p.id, { reference: 'slip-1', settledBy: 'ops@x.com' });
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(60), { bookings, log: new InMemoryNotificationLogRepo(), alerts, payments });
    expect(res.paidUnconfirmed).toBe(0);
    expect(alerts.sent).toHaveLength(0);
  });

  it('still alerts a gateway-paid booking whose confirmation never went out', async () => {
    const { bookings, booking } = await seed('paid');
    const payments = new InMemoryPaymentRepo();
    const p = await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: 5000, currency: 'USD', idempotencyKey: `web:${booking.id}`,
    });
    await payments.markSucceeded(p.id);
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(60), { bookings, log: new InMemoryNotificationLogRepo(), alerts, payments });
    expect(res.paidUnconfirmed).toBe(1);
    expect(alerts.sent[0].kind).toBe('watchdog_paid_unconfirmed');
  });

  it('skips ops-booked (channel whatsapp) bookings — no stuck alert, no recovery email', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, channel: 'whatsapp' });
    await bookings.setStatus(b.id, 'payment_pending');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(31), {
      bookings,
      log: new InMemoryNotificationLogRepo(),
      alerts,
      email: new FakeEmailAdapter(),
      baseUrl: 'https://ops.example',
      linkSecret: 'secret',
    });
    expect(res.stuckPending).toBe(0);
    expect(res.recoveryEmails).toBe(0);
    expect(alerts.sent).toHaveLength(0);
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

describe('pay links re-arm the abandoned-checkout watch', () => {
  it('a whatsapp booking with a STARTED gateway checkout is watched again', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, channel: 'whatsapp' });
    await bookings.setStatus(b.id, 'payment_pending');
    const payments = new InMemoryPaymentRepo();
    await payments.create({
      bookingId: b.id, provider: 'payhere', orderId: b.reference,
      amount: 5000, currency: 'USD', idempotencyKey: `checkout:${b.id}`,
    }); // pending — the customer opened PayHere and walked away
    const alerts = new FakeAlertAdapter();
    const email = new FakeEmailAdapter();
    const res = await runWatchdog(later(31), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts, payments,
      email, baseUrl: 'https://ceylonhop.com', linkSecret: 'sek',
    });
    expect(res.stuckPending).toBe(1);
    expect(res.recoveryEmails).toBe(1);
    expect(email.sent[0].to).toBe('maya@example.com');
  });

  it('a whatsapp booking with NO payments stays exempt — cash is still collected by hand', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, channel: 'whatsapp' });
    await bookings.setStatus(b.id, 'payment_pending');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(31), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts, payments: new InMemoryPaymentRepo(),
    });
    expect(res.stuckPending).toBe(0);
    expect(alerts.sent).toHaveLength(0);
  });
});

// ── Burst cap (notification safety rails, slice 1) ─────────────────────────
describe('runWatchdog — burst cap', () => {
  async function seedManyPending(n: number) {
    const bookings = new InMemoryBookingRepo();
    for (let i = 0; i < n; i++) {
      const b = await bookings.create(sample);
      await bookings.setStatus(b.id, 'payment_pending');
    }
    return bookings;
  }

  it('caps customer recovery emails', async () => {
    const bookings = await seedManyPending(5);
    const email = new FakeEmailAdapter();
    const budget = new SendBudget(2);

    const res = await runWatchdog(later(45), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(),
      email, baseUrl: 'https://ceylonhop.com', linkSecret: 's', budget,
    });

    expect(res.recoveryEmails).toBe(2);
    expect(email.sent).toHaveLength(2);
    expect(budget.report().kinds).toEqual({ payment_recovery: 3 });
  });

  it('never caps ops ALERTS — suppressing the page would hide the problem', async () => {
    const bookings = await seedManyPending(5);
    const alerts = new FakeAlertAdapter();

    const res = await runWatchdog(later(45), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts,
      email: new FakeEmailAdapter(), baseUrl: 'https://ceylonhop.com', linkSecret: 's',
      budget: new SendBudget(0),
    });

    expect(res.stuckPending).toBe(5);
    expect(alerts.sent).toHaveLength(5); // all five still paged
    expect(res.recoveryEmails).toBe(0); // but no customer mail left the building
  });
});

// ── Dry run ────────────────────────────────────────────────────────────────
// Before the watchdog is scheduled against prod, the owner needs to see what its FIRST run
// would page about — historical paid bookings with no confirmation row would otherwise alert
// forever. So a dry run must report the plan and touch nothing: no alert, no customer email,
// no notification-log claim (a claim WRITES a row), no budget.
class RecordingLog extends InMemoryNotificationLogRepo {
  writes: string[] = [];
  override async markSent(bookingId: string, kind: NotificationKind) {
    this.writes.push(`markSent:${kind}`);
    return super.markSent(bookingId, kind);
  }
  override async claim(bookingId: string, kind: NotificationKind) {
    this.writes.push(`claim:${kind}`);
    return super.claim(bookingId, kind);
  }
  override async release(bookingId: string, kind: NotificationKind) {
    this.writes.push(`release:${kind}`);
    return super.release(bookingId, kind);
  }
}

describe('runWatchdog — dry run', () => {
  async function seedAll() {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const log = new RecordingLog();

    const stuck = await bookings.create(sample);
    await bookings.setStatus(stuck.id, 'payment_pending');
    // A second abandoned checkout that was already chased: still stuck, but no second email.
    const chased = await bookings.create(sample);
    await bookings.setStatus(chased.id, 'payment_pending');
    await log.markSent(chased.id, 'payment_recovery');

    const paid = await bookings.create(sample);
    await bookings.setStatus(paid.id, 'payment_pending');
    await bookings.setStatus(paid.id, 'paid');
    const p = await payments.create({
      bookingId: paid.id, provider: 'payhere', orderId: paid.reference,
      amount: 5000, currency: 'USD', idempotencyKey: `web:${paid.id}`,
    });
    await payments.markSucceeded(p.id);
    const refund = await refunds.request({
      bookingId: paid.id, amountCents: 1200, currency: 'USD', reason: 'Customer cancelled', requestedBy: 'founder@test',
    });
    const apiAttemptedAt = new Date(Date.now() - 3600_000);
    (refunds as unknown as { rows: Map<string, unknown> }).rows.set(refund.id, {
      ...refund, status: 'api_processing', apiAttemptedAt,
    });
    log.writes.length = 0; // only the sweep's own writes count

    return { bookings, payments, refunds, log, stuck, chased, paid, refund, apiAttemptedAt };
  }

  it('reports what WOULD happen per category, with zero side effects', async () => {
    const s = await seedAll();
    const alerts = new FakeAlertAdapter();
    const email = new FakeEmailAdapter();
    const budget = new SendBudget(10);

    const res = await runWatchdog(later(31), {
      bookings: s.bookings, log: s.log, alerts, email, baseUrl: 'https://ceylonhop.com', linkSecret: 'sek',
      payments: s.payments, refunds: s.refunds, budget, dryRun: true,
    });

    expect(res).toMatchObject({ stuckPending: 2, paidUnconfirmed: 1, recoveryEmails: 1, stuckRefunds: 1 });
    expect(res.plan?.stuckPending).toHaveLength(2);
    expect(res.plan?.stuckPending).toEqual(expect.arrayContaining([
      { reference: s.stuck.reference, createdAt: s.stuck.createdAt },
      { reference: s.chased.reference, createdAt: s.chased.createdAt },
    ]));
    expect(res.plan?.recoveryEmails).toEqual([{ reference: s.stuck.reference, createdAt: s.stuck.createdAt }]);
    expect(res.plan?.paidUnconfirmed).toEqual([{ reference: s.paid.reference, createdAt: s.paid.createdAt }]);
    expect(res.plan?.stuckRefunds).toEqual([{
      id: s.refund.id, bookingReference: s.paid.reference, amountCents: 1200, currency: 'USD',
      apiAttemptedAt: s.apiAttemptedAt.toISOString(),
    }]);

    // Nothing left the building, nothing was written, nothing was spent.
    expect(alerts.sent).toHaveLength(0);
    expect(email.sent).toHaveLength(0);
    expect(s.log.writes).toEqual([]);
    expect(await s.log.wasSent(s.stuck.id, 'payment_recovery')).toBe(false);
    expect(budget.sent).toBe(0);
    expect(budget.report().suppressed).toBe(0);

    // No customer PII in the report.
    const json = JSON.stringify(res);
    expect(json).not.toContain('maya@example.com');
    expect(json).not.toContain('+34600000000');
    expect(json).not.toContain('Silva');
  });

  it('consumes nothing — a real sweep afterwards still alerts and emails, with its shape unchanged', async () => {
    const s = await seedAll();
    const alerts = new FakeAlertAdapter();
    const email = new FakeEmailAdapter();
    const deps = {
      bookings: s.bookings, log: s.log, alerts, email, baseUrl: 'https://ceylonhop.com', linkSecret: 'sek',
      payments: s.payments, refunds: s.refunds,
    };

    await runWatchdog(later(31), { ...deps, dryRun: true });
    const real = await runWatchdog(later(31), deps);

    expect(real).toEqual({ stuckPending: 2, paidUnconfirmed: 1, recoveryEmails: 1, stuckRefunds: 1 });
    expect(real).not.toHaveProperty('plan');
    expect(alerts.sent).toHaveLength(4);
    expect(email.sent).toHaveLength(1);
  });
});
