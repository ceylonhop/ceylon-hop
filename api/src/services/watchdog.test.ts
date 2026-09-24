import { describe, it, expect } from 'vitest';
import { runWatchdog, checkWatchdogLiveness } from './watchdog';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
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

  // Review of #774, finding 5: a send that did not deliver is not a send. Burning the burst budget
  // on it meant a kill-switched or allowlisted booking could starve a real customer's recovery mail.
  for (const [how, first] of [
    ['suppressed', async () => ({ delivered: false as const, reason: 'suppressed_allowlist' as const })],
    ['thrown', async () => { throw new Error('smtp down'); }],
  ] as const) {
    it(`a ${how} recovery send gives its budget slot back, so the next booking is still mailed`, async () => {
      const bookings = await seedManyPending(2);
      const budget = new SendBudget(1);
      const delivered: string[] = [];
      let calls = 0;
      const email = {
        send: async (m: { to: string; subject: string }) => {
          calls += 1;
          if (calls === 1) return first();
          delivered.push(m.subject);
          return { delivered: true as const };
        },
      };

      const res = await runWatchdog(later(45), {
        bookings, log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(),
        email, baseUrl: 'https://ceylonhop.com', linkSecret: 's', budget,
      });

      expect(calls).toBe(2);
      expect(delivered).toHaveLength(1);
      expect(res.recoveryEmails).toBe(1);
      expect(budget.sent).toBe(1);
      expect(budget.report().suppressed).toBe(0);
    });
  }

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

// ── Audit 2026-09-22, finding 2 ────────────────────────────────────────────
// Once a suppressed confirmation stops being recorded as sent (so this watchdog can finally
// see it), the bookings that were NEVER due an email must not start paging instead. A
// WhatsApp-only customer has no address; that is a fact about them, not a silent failure,
// and nothing ever clears it — a paid booking stays 'paid' until departure, so without an
// exemption it would alert on every sweep for weeks and bury the real ones.
describe('watchdog — a customer with no email address is not a missing confirmation', () => {
  it('stays quiet for a paid booking whose customer has no email', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({
      ...sample,
      input: { ...sample.input, customer: { ...sample.input.customer, email: '' } },
    } as NewBooking);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(60), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.paidUnconfirmed).toBe(0);
    expect(alerts.sent).toHaveLength(0);
  });

  // The counterpart: an address we DO have and did not write to is exactly what it should shout about.
  it('still alerts when the customer has an address and no confirmation is recorded', async () => {
    const { bookings } = await seed('paid');
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(60), { bookings, log: new InMemoryNotificationLogRepo(), alerts });
    expect(res.paidUnconfirmed).toBe(1);
  });
});

// ── Instrumentation (CH-V43ZU, 2026-09-24) ─────────────────────────────────
// The alert used to say "pending since <timestamp>" and nothing else, so the reader had to
// open three tables to learn whether the customer ever reached the gateway, whether PayHere
// ever answered, and whether the recovery email went out. Now the email says it.
describe('watchdog — the stuck-pending alert says what it knows', () => {
  async function seedWithGatewayPayment() {
    const { bookings, booking } = await seed('payment_pending');
    const payments = new InMemoryPaymentRepo();
    await payments.create({
      bookingId: booking.id, provider: 'payhere', orderId: booking.reference,
      amount: 5000, currency: 'USD', idempotencyKey: `checkout:${booking.id}`,
    });
    return { bookings, booking, payments };
  }
  const mailDeps = { baseUrl: 'https://ceylonhop.com', linkSecret: 'sek' };

  it('names the route, the gateway payment, the recovery email and the ops link', async () => {
    const { bookings, booking, payments } = await seedWithGatewayPayment();
    const alerts = new FakeAlertAdapter();
    await runWatchdog(later(31), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts, payments, ...mailDeps,
      email: new FakeEmailAdapter(), opsBaseUrl: 'https://ops.example',
    });
    const body = alerts.sent[0].body;
    expect(body).toContain('→ Ella');
    expect(body).toContain('Channel: website');
    expect(body).toMatch(/Gateway: payhere · pending · order CH-/);
    expect(body).toContain('PayHere has not called back');
    expect(body).toContain('Recovery email: sent just now');
    expect(body).toContain(`https://ops.example/ops?booking=${booking.id}`);
  });

  it('says so when checkout was never started (no gateway payment at all)', async () => {
    const { bookings } = await seed('payment_pending');
    const alerts = new FakeAlertAdapter();
    await runWatchdog(later(31), { bookings, log: new InMemoryNotificationLogRepo(), alerts, payments: new InMemoryPaymentRepo() });
    expect(alerts.sent[0].body).toContain('no gateway payment was ever created');
    expect(alerts.sent[0].body).toContain('Recovery email: not configured');
  });

  // A suppressed send (kill switch / allowlist) is not a delivery: counting it and keeping
  // its one-shot claim would tell ops the customer was chased when nobody was, and burn the
  // only recovery email that booking will ever get.
  it('a suppressed recovery email is not counted, hands back its claim, and the alert says why', async () => {
    const { bookings, booking, payments } = await seedWithGatewayPayment();
    const log = new InMemoryNotificationLogRepo();
    const alerts = new FakeAlertAdapter();
    const email = { send: async () => ({ delivered: false as const, reason: 'suppressed_allowlist' as const }) };
    const res = await runWatchdog(later(31), { bookings, log, alerts, payments, ...mailDeps, email });
    expect(res.recoveryEmails).toBe(0);
    expect(await log.wasSent(booking.id, 'payment_recovery')).toBe(false);
    expect(alerts.sent[0].body).toContain('Recovery email: NOT delivered (suppressed_allowlist');
  });

  it('a delivered recovery email is counted and keeps its claim', async () => {
    const { bookings, booking, payments } = await seedWithGatewayPayment();
    const log = new InMemoryNotificationLogRepo();
    const alerts = new FakeAlertAdapter();
    const res = await runWatchdog(later(31), { bookings, log, alerts, payments, ...mailDeps, email: new FakeEmailAdapter() });
    expect(res.recoveryEmails).toBe(1);
    expect(await log.wasSent(booking.id, 'payment_recovery')).toBe(true);
  });

  // No address is a fact about the customer, not a failure: nothing to count, nothing to
  // retry. Checked before claiming so no ledger row asserts a send that never happened.
  it('a customer with no email address gets no recovery attempt, now or on later sweeps', async () => {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, input: { ...sample.input, customer: { ...sample.input.customer, email: '' } } });
    await bookings.setStatus(b.id, 'payment_pending');
    const log = new InMemoryNotificationLogRepo();
    const alerts = new FakeAlertAdapter();
    let attempts = 0;
    const email = { send: async () => { attempts += 1; return { delivered: false as const, reason: 'no_address' as const }; } };
    const deps = { bookings, log, alerts, ...mailDeps, email };
    const res = await runWatchdog(later(31), deps);
    await runWatchdog(later(46), deps);
    expect(res.recoveryEmails).toBe(0);
    expect(attempts).toBe(0);
    expect(await log.wasSent(b.id, 'payment_recovery')).toBe(false);
    expect(alerts.sent[0].body).toContain('Recovery email: none — the customer has no email address');
  });

  it('reports a recovery email that went out on an earlier sweep', async () => {
    const { bookings, booking, payments } = await seedWithGatewayPayment();
    const log = new InMemoryNotificationLogRepo();
    await log.markSent(booking.id, 'payment_recovery');
    const alerts = new FakeAlertAdapter();
    await runWatchdog(later(31), { bookings, log, alerts, payments, ...mailDeps, email: new FakeEmailAdapter() });
    expect(alerts.sent[0].body).toContain('Recovery email: already sent');
  });
});

// Nothing recorded when the watchdog ran, so "why did this alert arrive 3 h in, not 30 min?"
// (CH-V43ZU) had no answer. Every sweep now stamps the alert ledger, and the daily tick
// checks the stamp — the monitor is itself monitored.
describe('watchdog — every sweep leaves a footprint', () => {
  it('records the tick in the alert ledger', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const now = later(0);
    await runWatchdog(now, { bookings: new InMemoryBookingRepo(), log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(), alertLog });
    expect(await alertLog.lastSentAt('watchdog_tick', 'last')).toEqual(now);
  });

  it('a later tick overwrites the earlier one, however close together', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const deps = { bookings: new InMemoryBookingRepo(), log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(), alertLog };
    const first = later(0);
    const second = new Date(first.getTime() + 1_000);
    await runWatchdog(first, deps);
    await runWatchdog(second, deps);
    expect(await alertLog.lastSentAt('watchdog_tick', 'last')).toEqual(second);
  });
});

describe('checkWatchdogLiveness', () => {
  it('alerts when no tick was ever recorded', async () => {
    const alerts = new FakeAlertAdapter();
    const r = await checkWatchdogLiveness(later(0), { alertLog: new InMemoryAlertLogRepo(), alerts });
    expect(r.stale).toBe(true);
    expect(alerts.sent[0].kind).toBe('watchdog_stale');
    expect(alerts.sent[0].body).toContain('never');
  });

  it('alerts when the last tick is older than an hour', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const alerts = new FakeAlertAdapter();
    const t0 = later(0);
    await runWatchdog(t0, { bookings: new InMemoryBookingRepo(), log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(), alertLog });
    const r = await checkWatchdogLiveness(new Date(t0.getTime() + 61 * MIN), { alertLog, alerts });
    expect(r.stale).toBe(true);
    expect(alerts.sent[0].body).toContain('61 min ago');
  });

  it('stays quiet when the watchdog ran recently', async () => {
    const alertLog = new InMemoryAlertLogRepo();
    const alerts = new FakeAlertAdapter();
    const t0 = later(0);
    await runWatchdog(t0, { bookings: new InMemoryBookingRepo(), log: new InMemoryNotificationLogRepo(), alerts: new FakeAlertAdapter(), alertLog });
    const r = await checkWatchdogLiveness(new Date(t0.getTime() + 20 * MIN), { alertLog, alerts });
    expect(r.stale).toBe(false);
    expect(alerts.sent).toHaveLength(0);
  });
});

// Review of #774, finding 7. TEAM_EMAILS (#764) marks the owner's and team's own test bookings;
// the ops queue and the digest leave them out, but the watchdog still chased them — a recovery
// email to the owner and a critical page about the owner's own test checkout.
describe('runWatchdog — team test bookings', () => {
  async function seedFor(email: string) {
    const bookings = new InMemoryBookingRepo();
    const b = await bookings.create({ ...sample, input: { ...sample.input, customer: { ...sample.input.customer, email } } } as NewBooking);
    await bookings.setStatus(b.id, 'payment_pending');
    return { bookings, booking: b };
  }
  const mail = { baseUrl: 'https://ceylonhop.com', linkSecret: 's' };

  it('skips a stuck booking made under a team address: no recovery email, no alert', async () => {
    const { bookings } = await seedFor(' Owner@CeylonHop.com ');
    const alerts = new FakeAlertAdapter();
    const email = new FakeEmailAdapter();
    const log = new InMemoryNotificationLogRepo();
    const res = await runWatchdog(later(31), {
      bookings, log, alerts, email, ...mail, teamEmails: new Set(['owner@ceylonhop.com']),
    });
    expect(res.stuckPending).toBe(0);
    expect(res.recoveryEmails).toBe(0);
    expect(email.sent).toHaveLength(0);
    expect(alerts.sent).toHaveLength(0);
  });

  it('still chases a customer booking alongside it', async () => {
    const { bookings, booking } = await seedFor('maya@example.com');
    const alerts = new FakeAlertAdapter();
    const email = new FakeEmailAdapter();
    const res = await runWatchdog(later(31), {
      bookings, log: new InMemoryNotificationLogRepo(), alerts, email, ...mail, teamEmails: new Set(['owner@ceylonhop.com']),
    });
    expect(res.stuckPending).toBe(1);
    expect(email.sent).toHaveLength(1);
    expect(alerts.sent[0].body).toContain(booking.reference);
  });

  it('an empty team set (or none) changes nothing', async () => {
    for (const teamEmails of [new Set<string>(), undefined]) {
      const { bookings } = await seedFor('owner@ceylonhop.com');
      const alerts = new FakeAlertAdapter();
      const email = new FakeEmailAdapter();
      const res = await runWatchdog(later(31), {
        bookings, log: new InMemoryNotificationLogRepo(), alerts, email, ...mail, ...(teamEmails ? { teamEmails } : {}),
      });
      expect(res.stuckPending).toBe(1);
      expect(email.sent).toHaveLength(1);
      expect(alerts.sent).toHaveLength(1);
    }
  });
});
