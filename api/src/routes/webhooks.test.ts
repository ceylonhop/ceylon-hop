import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { InMemoryBookingRepo } from '../db/bookingRepo';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function bookAndCheckout(app: ReturnType<typeof createApp>) {
  const b = await (
    await app.request('/bookings/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(valid),
    })
  ).json();
  await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
  return b;
}

describe('POST /webhooks/payments', () => {
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

  it('marks a deposit-charged chauffeur booking paid on a deposit-amount webhook (GL-3)', async () => {
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
          dates: ['2026-07-20', '2026-07-22'],
          pax: 2,
          vehicleType: 'car',
          serviceType: 'chauffeur',
          customer: valid.customer,
        }),
      })
    ).json();
    const checkout = await (await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' })).json();
    expect(checkout.amount).toBe(b.amountDueNow); // the deposit, not the total
    expect(checkout.amount).toBeLessThan(b.total);

    // PayHere notifies for what was actually charged — the deposit — and that settles it.
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

  it('does NOT mark the booking paid when the payment failed (acknowledge, no email)', async () => {
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
    expect(email.sent).toHaveLength(0);
  });
});

describe('payment webhook ops alerts (M17)', () => {
  it('alerts on an invalid signature', async () => {
    const alerts = new FakeAlertAdapter();
    const app = createApp({ alerts });
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: '{"orderId":"x","amount":1,"currency":"USD","status":"succeeded","providerTxnId":"t","signature":"bad"}',
    });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0].kind).toBe('payhere_signature');
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
