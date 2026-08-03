import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { PayHerePaymentAdapter } from '../adapters/payhere';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { futureIsoDate } from '../testSupport/dates';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signQuotePayToken } from '../lib/bookingToken';

const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: futureIsoDate(30), // anchored to "now" so the past-date rule never expires it
  time: '09:00',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function bookAndCheckout(app: ReturnType<typeof createApp>, overrides: Record<string, unknown> = {}) {
  const b = await (
    await app.request('/bookings/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, ...overrides }),
    })
  ).json();
  await app.request(`/bookings/${b.id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${b.checkoutToken}` },
  });
  return b;
}

describe('POST /webhooks/payments', () => {
  it('rejects PayHere notifications sent with a non-form content type', async () => {
    const adapter = new PayHerePaymentAdapter('1234567', 'test-secret', {
      mode: 'sandbox',
      notifyUrl: 'https://example.com/webhooks/payments',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    });
    const body = adapter.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    const app = createApp({ adapter });

    const res = await app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    });

    expect(res.status).toBe(401);
  });

  it('marks the booking paid and emails the customer on a valid webhook', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await bookAndCheckout(app);

    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);

    const after = await bookings.get(b.id);
    expect(after!.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].to).toBe('maya@example.com');
    // the branded confirmation actually flows end-to-end through the webhook
    expect(email.sent[0].subject).toContain(b.reference);
    expect(email.sent[0].subject.toLowerCase()).toContain('confirmed');
    expect(email.sent[0].text).toBeTruthy();
  });

  it('marks paid and returns 200 even if the confirmation email fails (best-effort)', async () => {
    const adapter = new FakePaymentAdapter();
    const email = { send: async () => { throw new Error('provider down'); } };
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });

    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    const after = await bookings.get(b.id);
    expect(after!.status).toBe('paid');
  });

  it('marks the payment row failed on a non-success webhook (was left pending forever)', async () => {
    const adapter = new FakePaymentAdapter();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ adapter, bookings, payments });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency, status: 'failed' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    const pay = await payments.findByOrderId(b.reference);
    expect(pay!.status).toBe('failed'); // was 'pending' before the fix
    // the booking itself is untouched — still awaiting a (re)payment
    expect((await bookings.get(b.id))!.status).toBe('payment_pending');
  });

  it('is idempotent — a duplicate webhook does not re-pay or re-email', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const app = createApp({ adapter, email });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });

    await app.request('/webhooks/payments', { method: 'POST', body });
    const dup = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(dup.status).toBe(200);
    expect(email.sent).toHaveLength(1);
  });

  it('handles concurrent success notifications with one email and one concierge task', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const app = createApp({ adapter, email, conciergeTasks });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({
      orderId: b.reference,
      amount: b.total,
      currency: b.currency,
    });

    const responses = await Promise.all([
      app.request('/webhooks/payments', { method: 'POST', body }),
      app.request('/webhooks/payments', { method: 'POST', body }),
    ]);

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(email.sent).toHaveLength(1);
    expect(
      (await conciergeTasks.listByBooking(b.id)).filter((task) => task.type === 'confirm_pickup'),
    ).toHaveLength(1);
  });

  it('files a confirm_pickup concierge task on paid', async () => {
    const adapter = new FakePaymentAdapter();
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const app = createApp({ adapter, conciergeTasks });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    await app.request('/webhooks/payments', { method: 'POST', body });

    // the unresolvable test route also files an unpriced-booking flag — count pickups only
    const tasks = await conciergeTasks.listByBooking(b.id);
    expect(tasks.filter((t) => t.type === 'confirm_pickup')).toHaveLength(1);
  });

  it('marks a chauffeur booking paid on a full-amount webhook', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await (
      await app.request('/bookings/trip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
          nights: [1, 2, 0],
          dates: [futureIsoDate(30), futureIsoDate(32)],
          pax: 2,
          vehicleType: 'car',
          serviceType: 'chauffeur',
          customer: valid.customer,
        }),
      })
    ).json();
    const checkout = await (
      await app.request(`/bookings/${b.id}/checkout`, {
        method: 'POST',
        headers: { authorization: `Bearer ${b.checkoutToken}` },
      })
    ).json();
    expect(checkout.amount).toBe(b.amountDueNow);
    expect(checkout.amount).toBe(b.total);

    // PayHere notifies for what was actually charged and that settles it.
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: checkout.amount, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    const after = await bookings.get(b.id);
    expect(after!.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
  });

  it('rejects a bad signature (401)', async () => {
    const app = createApp();
    const res = await app.request('/webhooks/payments', {
      method: 'POST',
      body: '{"orderId":"x","amount":1,"currency":"USD","status":"succeeded","providerTxnId":"t","signature":"bad"}',
    });
    expect(res.status).toBe(401);
  });

  it('rejects an amount mismatch (400)', async () => {
    const adapter = new FakePaymentAdapter();
    const app = createApp({ adapter });
    const b = await bookAndCheckout(app);
    const tampered = adapter.simulateWebhook({
      orderId: b.reference,
      amount: b.total + 1000,
      currency: b.currency,
    });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: tampered });
    expect(res.status).toBe(400);
  });

  it('rejects a currency mismatch (400) and leaves the booking unpaid', async () => {
    const adapter = new FakePaymentAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, bookings });
    const b = await bookAndCheckout(app); // priced in USD
    const wrongCurrency = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: 'EUR' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: wrongCurrency });
    expect(res.status).toBe(400);
    const after = await bookings.get(b.id);
    expect(after!.status).not.toBe('paid');
  });

  it('does NOT mark the booking paid when the payment failed, but sends one retry nudge', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await bookAndCheckout(app);
    const failed = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency, status: 'failed' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: failed });
    expect(res.status).toBe(200); // acknowledged so PayHere won't retry…
    const after = await bookings.get(b.id);
    expect(after!.status).toBe('payment_pending'); // …but the booking must NOT be paid
    // The customer gets an immediate "payment didn't go through" nudge to retry.
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].subject.toLowerCase()).toContain("didn’t go through");
  });

  it('does not re-send the payment-failed email on a duplicate failure notification', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await bookAndCheckout(app);
    const failed = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency, status: 'failed' });
    await app.request('/webhooks/payments', { method: 'POST', body: failed });
    await app.request('/webhooks/payments', { method: 'POST', body: failed });
    expect(email.sent).toHaveLength(1); // idempotent — only one nudge
  });
});

describe('payment webhook ops alerts (M17)', () => {
  // The fake adapter cannot diagnose itself, so the alert declines to guess rather than
  // asserting a signature failure it has no evidence for — that guess is exactly what sent the
  // owner looking at the merchant secret on 2026-08-02 while a customer's card was declining.
  it('alerts without blaming the signature when the adapter cannot say why', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ alerts });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: '{"orderId":"x","amount":1,"currency":"USD","status":"succeeded","providerTxnId":"t","signature":"bad"}',
    });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].kind).toBe('payhere_webhook_rejected');
    expect(alerts.sent[0].severity).toBe('critical');
  });

  it('alerts on an amount mismatch with the order id', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adapter, alerts });
    const b = await bookAndCheckout(app);
    const tampered = adapter.simulateWebhook({ orderId: b.reference, amount: b.total + 1000, currency: b.currency });
    await app.request('/webhooks/payments', { method: 'POST', body: tampered });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].kind).toBe('payhere_amount');
    expect(alerts.sent[0].dedupeKey).toBe(b.reference);
  });

  // Owner-reported 2026-08-02: a real $39 payment settled and nobody on the team was told.
  // Nothing notified on a paid booking — no email, no Slack, no Sentry event. The only signals
  // were a once-daily aggregate digest and a watchdog whose 15-minute cron was never set up.
  // Money arriving is the one event the team must not learn about by accident.
  it('tells the team when a booking is paid', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adapter, alerts });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    await app.request('/webhooks/payments', { method: 'POST', body });

    const paid = alerts.sent.find((a) => a.kind === 'booking_paid');
    expect(paid).toBeTruthy();
    expect(paid?.severity).toBe('info'); // good news, not a failure — must not read as an incident
    expect(paid?.title).toContain(b.reference);
    expect(paid?.dedupeKey).toBe(b.reference); // a PayHere retry must not re-notify
  });

  it('the team notification never costs the customer their confirmation', async () => {
    // The customer's email comes first and the team's is best-effort behind it: a failure in
    // ours must not cost them theirs, and must not fail the webhook (PayHere would retry).
    const adapter = new FakePaymentAdapter();
    const alerts = { send: async () => { throw new Error('alert channel down'); } };
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, alerts, email, bookings });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });

    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('paid');
    expect(email.sent.length).toBeGreaterThan(0);
  });

  it('alerts when the booking is paid but the confirmation email fails', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const email = { send: async () => { throw new Error('provider down'); } };
    const app = createApp({ adapter, alerts, email });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200); // webhook contract unchanged
    expect(alerts.sent.map((a) => a.kind)).toContain('confirmation_email_failed');
    expect(alerts.sent.find((a) => a.kind === 'confirmation_email_failed')?.body).toContain(b.reference);
  });

  it('records the confirmation send in the notification log (watchdog signal)', async () => {
    const adapter = new FakePaymentAdapter();
    const notificationLog = new InMemoryNotificationLogRepo();
    const app = createApp({ adapter, notificationLog });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    await app.request('/webhooks/payments', { method: 'POST', body });
    expect(await notificationLog.wasSent(b.id, 'confirmation')).toBe(true);
  });

  it('alerts (never silently swallows) a reversal/chargeback on an already-settled payment', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adapter, alerts });
    const b = await bookAndCheckout(app);
    // settle it
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }),
    });
    // a later NON-success notify (PayHere cancel/chargeback) for the same settled order
    const reversal = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency, status: 'failed' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: reversal });
    expect(res.status).toBe(200);
    expect(alerts.sent.map((a) => a.kind)).toContain('payment_reversed');
  });

  it('alerts when a payment settles for a booking no longer in payment_pending (money with nowhere to go)', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, alerts, bookings });
    const b = await bookAndCheckout(app); // payment_pending
    await bookings.setStatus(b.id, 'cancelled'); // ops cancels while the customer is on PayHere
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('cancelled'); // NOT flipped to paid
    expect(alerts.sent.map((a) => a.kind)).toContain('paid_in_unexpected_status');
  });

  // A late notify on a booking ops already settled in cash: two succeeded payments on one
  // booking, and refundRepo sums them, so the refundable ceiling really is cash + gateway. The
  // money is genuinely captured twice — the alert has to say THAT, not the old generic
  // "captured with no paid-transition", which describes a different (and cheaper) accident.
  it('alerts a DOUBLE CAPTURE when a late gateway payment lands on a cash-settled booking', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ adapter, alerts, bookings, payments });
    const b = await bookAndCheckout(app); // payment_pending, gateway payment row waiting
    // ops takes the cash and marks it paid while the customer's PayHere notify is in flight
    const manual = await payments.create({
      bookingId: b.id, provider: 'cash', orderId: `${b.reference}-MANUAL`,
      amount: b.total, currency: b.currency, idempotencyKey: `manual-paid:${b.id}`,
    });
    await payments.markSucceededManually(manual.id, { reference: 'slip-9' });
    await bookings.setStatus(b.id, 'paid');

    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });

    expect(res.status).toBe(200);
    expect(alerts.sent.map((a) => a.kind)).toContain('payment_double_capture');
    expect(alerts.sent.map((a) => a.kind)).not.toContain('paid_in_unexpected_status');
    // the gateway money is recorded, not dropped — the business is holding both amounts
    expect((await payments.findByOrderId(b.reference))!.status).toBe('succeeded');
  });

  it('does not 500 the webhook when concierge-task creation fails (booking stays paid, alert raised)', async () => {
    const adapter = new FakePaymentAdapter();
    const alerts = new FakeAlertAdapter();
    const bookings = new InMemoryBookingRepo();
    class FailingTasks extends InMemoryConciergeTaskRepo {
      async create(): Promise<never> { throw new Error('tasks down'); }
    }
    const app = createApp({ adapter, alerts, bookings, conciergeTasks: new FailingTasks() });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200); // booking is already paid; a task hiccup must not make PayHere retry
    expect((await bookings.get(b.id))!.status).toBe('paid');
    expect(alerts.sent.map((a) => a.kind)).toContain('concierge_task_failed');
  });
});

describe('POST /webhooks/resend (M17)', () => {
  const SECRET_KEY = Buffer.from('super-secret-signing-key').toString('base64');
  const SECRET = 'whsec_' + SECRET_KEY;

  const signed = (payload: object, opts?: { timestamp?: number; badSig?: boolean }) => {
    const raw = JSON.stringify(payload);
    const id = 'msg_test1';
    const timestamp = String(opts?.timestamp ?? Math.floor(Date.now() / 1000));
    const sig = createHmac('sha256', Buffer.from(SECRET_KEY, 'base64'))
      .update(`${id}.${timestamp}.${raw}`)
      .digest('base64');
    return {
      body: raw,
      headers: {
        'svix-id': id,
        'svix-timestamp': timestamp,
        'svix-signature': `v1,${opts?.badSig ? 'AAAA' + sig.slice(4) : sig}`,
      },
    };
  };

  it('does not exist (404) when RESEND_WEBHOOK_SECRET is unset', async () => {
    const app = createApp();
    const { body, headers } = signed({ type: 'email.bounced', data: { to: ['x@y.com'] } });
    const res = await app.request('/webhooks/resend', { method: 'POST', body, headers });
    expect(res.status).toBe(404);
  });

  it('rejects a bad signature (401), accepts a good one and alerts on a bounce', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ alerts, resendWebhookSecret: SECRET });

    const bad = signed({ type: 'email.bounced', data: { to: ['maya@example.com'] } }, { badSig: true });
    expect((await app.request('/webhooks/resend', { method: 'POST', body: bad.body, headers: bad.headers })).status).toBe(401);
    expect(alerts.sent).toHaveLength(0);

    const good = signed({ type: 'email.bounced', data: { to: ['maya@example.com'], subject: 'Your booking' } });
    const res = await app.request('/webhooks/resend', { method: 'POST', body: good.body, headers: good.headers });
    expect(res.status).toBe(204);
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].kind).toBe('email_bounce');
    expect(alerts.sent[0].title).toContain('maya@example.com');
  });

  it('rejects a stale timestamp (replay guard)', async () => {
    const app = createApp({ resendWebhookSecret: SECRET });
    const stale = signed({ type: 'email.bounced', data: {} }, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    const res = await app.request('/webhooks/resend', { method: 'POST', body: stale.body, headers: stale.headers });
    expect(res.status).toBe(401);
  });

  it('acknowledges non-bounce events without alerting', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ alerts, resendWebhookSecret: SECRET });
    const ok = signed({ type: 'email.delivered', data: { to: ['maya@example.com'] } });
    const res = await app.request('/webhooks/resend', { method: 'POST', body: ok.body, headers: ok.headers });
    expect(res.status).toBe(204);
    expect(alerts.sent).toHaveLength(0);
  });
});

describe('POST /webhooks/payments — awaiting-details follow-up', () => {
  it('sends a "we need your details" email in addition to the confirmation when the date is flexible', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    // flexible booking: no date/time
    const b = await bookAndCheckout(app, { date: undefined, time: undefined });

    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    expect((await app.request('/webhooks/payments', { method: 'POST', body })).status).toBe(200);

    expect(email.sent).toHaveLength(2);
    expect(email.sent.some((m) => /confirmed/i.test(m.subject))).toBe(true);
    const details = email.sent.find((m) => /detail/i.test(m.subject));
    expect(details).toBeTruthy();
    expect(details!.to).toBe('maya@example.com');
    expect(details!.html.toLowerCase()).toContain('whatsapp');
  });

  it('sends only the confirmation when the booking already has a date', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });
    const b = await bookAndCheckout(app); // dated fixture

    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    await app.request('/webhooks/payments', { method: 'POST', body });

    expect(email.sent).toHaveLength(1);
    expect(email.sent.some((m) => /detail/i.test(m.subject))).toBe(false);
  });
});

describe('settlement claims the quote (pay links)', () => {
  // The full loop: mint-shaped quote → /start creates the booking → checkout → PayHere
  // notify settles → the QUOTE flips to won. Money is what wins a quote, nothing earlier.
  it('a settling payment flips the linked quote sent → won', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const adapter = new PayHerePaymentAdapter('1234567', 'test-secret', {
      mode: 'sandbox',
      notifyUrl: 'https://example.com/webhooks/payments',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    });
    const app = createApp({ quotes, bookings, payments, adapter, bookingLinkSecret: 'test-link-secret' });

    const q = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Nimal Perera',
      totalCents: 21900, currency: 'USD', rateCardVersion: 'v1', requestedService: 'private',
      request: { tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120, date: futureIsoDate(30) }] },
                 engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] } },
      result: {},
    });
    await quotes.patch(q.id, { status: 'pending_review' });
    await quotes.patch(q.id, { status: 'ready' });
    await quotes.patch(q.id, { status: 'sent' });

    const t = signQuotePayToken(q.id, (await quotes.get(q.id))!.revision, 'test-link-secret');
    const started = await (await app.request('/quotes/pay/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ t, customer: { firstName: 'Nimal', lastName: 'Perera', email: 'n@x.com', whatsapp: '+94770001111', country: 'LK' }, termsAccepted: true }),
    })).json();
    await app.request(`/bookings/${started.bookingId}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${started.checkoutToken}` },
    });
    expect((await quotes.get(q.id))?.status).toBe('sent'); // checkout intent alone wins nothing

    const booking = (await bookings.get(started.bookingId))!;
    const res = await app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: adapter.simulateNotify({ orderId: booking.reference, amount: 21900, currency: 'USD' }),
    });
    expect(res.status).toBe(200);
    expect((await bookings.get(started.bookingId))?.status).toBe('paid');
    expect((await quotes.get(q.id))?.status).toBe('won');
  });

  it('a settle on a booking with no quote behind it changes nothing and never errors', async () => {
    const adapter = new PayHerePaymentAdapter('1234567', 'test-secret', {
      mode: 'sandbox', notifyUrl: 'https://example.com/webhooks/payments',
      returnUrl: 'https://example.com/r', cancelUrl: 'https://example.com/c',
    });
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ adapter, quotes });
    const b = await bookAndCheckout(app);
    const res = await app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: adapter.simulateNotify({ orderId: b.reference, amount: b.total, currency: 'USD' }),
    });
    expect(res.status).toBe(200);
  });
});

// 2026-08-02: a [CRITICAL] "PayHere webhook signature failed — misconfigured merchant secret or
// someone probing" landed in the owner's inbox at the same moment a Chase Visa was being
// declined. The secret was fine (Amex settled all day). The alert could not distinguish a real
// notify we refused on a field rule from a bot poking a public URL, and it kept none of the body.
describe('payment webhook rejection alerts', () => {
  const payhere = () =>
    new PayHerePaymentAdapter('1234567', 'test-secret', {
      mode: 'sandbox',
      notifyUrl: 'https://example.com/webhooks/payments',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    });
  const post = (app: ReturnType<typeof createApp>, body: string) =>
    app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });

  it('still calls a genuine signature failure what it is', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const signed = adapter.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    await post(createApp({ adapter, alerts }), signed.replace(/md5sig=[A-F0-9]{32}/, `md5sig=${'A'.repeat(32)}`));
    expect(alerts.sent[0]).toMatchObject({ kind: 'payhere_signature', severity: 'critical' });
    expect(alerts.sent[0].body).toContain('PAYHERE_MERCHANT_SECRET');
  });

  it('does not blame the secret for a body refused before the signature was reached', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const signed = adapter.simulateNotify({ orderId: 'CH-MCF8D', amount: 2900, currency: 'USD', statusCode: '-2' });
    await post(createApp({ adapter, alerts }), signed.replace('status_code=-2', 'status_code=-9'));
    expect(alerts.sent[0].kind).toBe('payhere_webhook_rejected');
    expect(alerts.sent[0].title).toContain('status_code_unknown');
    expect(alerts.sent[0].body).not.toContain('PAYHERE_MERCHANT_SECRET');
  });

  // The one fact that turns the alert into an action: go and reconcile THIS booking.
  it('names the order the refused notify was about', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const signed = adapter.simulateNotify({ orderId: 'CH-MCF8D', amount: 2900, currency: 'USD', statusCode: '-2' });
    await post(createApp({ adapter, alerts }), signed.replace('status_code=-2', 'status_code=-9'));
    expect(alerts.sent[0].body).toContain('CH-MCF8D');
  });

  it('never puts the raw body in the alert — a notify carries the payer name and card number', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const signed = adapter.simulateNotify({ orderId: 'CH-MCF8D', amount: 2900, currency: 'USD' });
    await post(createApp({ adapter, alerts }), `${signed}&card_holder_name=Roshen+Weliwatta&card_no=************2478&status_code=-9`);
    const alert = alerts.sent[0];
    expect(alert.body).not.toContain('Roshen');
    expect(alert.body).not.toContain('2478');
    expect(alert.body).toMatch(/Body sha256: [0-9a-f]{64}/);
  });

  // Was `new Date().toISOString().slice(0,10)` — one alert per DAY across every cause, so a
  // rejected notify and a scanner probe on the same day collapsed and the second was never seen.
  it('dedupes per reason per day, not per day', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adapter, alerts });
    const signed = adapter.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    await post(app, signed.replace('status_code=2', 'status_code=9'));
    await post(app, signed.replace(/md5sig=[A-F0-9]{32}/, `md5sig=${'A'.repeat(32)}`));
    const keys = alerts.sent.map((a) => a.dedupeKey);
    expect(new Set(keys).size).toBe(2);
    expect(keys.every((k) => k?.startsWith(new Date().toISOString().slice(0, 10)))).toBe(true);
  });

  it('reports an unexpected content type as itself', async () => {
    const adapter = payhere();
    const alerts = new FakeAlertAdapter();
    const signed = adapter.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    await createApp({ adapter, alerts }).request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: signed,
    });
    expect(alerts.sent[0].title).toContain('content_type_unexpected');
  });
});
