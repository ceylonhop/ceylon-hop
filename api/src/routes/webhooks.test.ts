import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';

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
    const app = createApp({ adapter, email });
    const b = await bookAndCheckout(app);

    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);

    const after = await (await app.request(`/bookings/${b.id}`)).json();
    expect(after.status).toBe('paid');
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
    const app = createApp({ adapter, email });
    const b = await bookAndCheckout(app);
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });

    const res = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(res.status).toBe(200);
    const after = await (await app.request(`/bookings/${b.id}`)).json();
    expect(after.status).toBe('paid');
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

    const tasks = await conciergeTasks.listByBooking(b.id);
    expect(tasks).toHaveLength(1);
    expect(tasks[0].type).toBe('confirm_pickup');
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
    const app = createApp({ adapter });
    const b = await bookAndCheckout(app); // priced in USD
    const wrongCurrency = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: 'EUR' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: wrongCurrency });
    expect(res.status).toBe(400);
    const after = await (await app.request(`/bookings/${b.id}`)).json();
    expect(after.status).not.toBe('paid');
  });

  it('does NOT mark the booking paid when the payment failed (acknowledge, no email)', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const app = createApp({ adapter, email });
    const b = await bookAndCheckout(app);
    const failed = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency, status: 'failed' });
    const res = await app.request('/webhooks/payments', { method: 'POST', body: failed });
    expect(res.status).toBe(200); // acknowledged so PayHere won't retry…
    const after = await (await app.request(`/bookings/${b.id}`)).json();
    expect(after.status).toBe('payment_pending'); // …but the booking must NOT be paid
    expect(email.sent).toHaveLength(0);
  });
});
