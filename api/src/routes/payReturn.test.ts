import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { PayHerePaymentAdapter } from '../adapters/payhere';
import { isoToday } from '../domain/dateRules';
import { signPayReturnToken, signBookingToken, signCheckoutToken } from '../lib/bookingToken';

const SECRET = 'dev-booking-link-secret-change-me';
const SOON = isoToday('Asia/Colombo', new Date(Date.now() + 30 * 86_400_000));

const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: SOON,
  time: '09:00',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function book(app: ReturnType<typeof createApp>) {
  const res = await app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(valid),
  });
  return res.json();
}

function ret(app: ReturnType<typeof createApp>, rt: string) {
  return app.request(`/bookings/pay-return?rt=${encodeURIComponent(rt)}`);
}

// The redirect checkout's return leg (spec: docs/checkout-redirect-spec.md §D5/§D6). PayHere
// documents that NO payment status is passed back on the redirect, so the returning page must
// ask us — and we answer from our own settlement state, which the webhook owns.
describe('GET /bookings/pay-return', () => {
  it('refuses a missing, garbage, or wrong-secret token', async () => {
    const app = createApp();
    expect((await app.request('/bookings/pay-return')).status).toBe(401);
    expect((await ret(app, 'garbage')).status).toBe(401);
    const b = await book(app);
    expect((await ret(app, signPayReturnToken(b.id, 'other-secret'))).status).toBe(401);
  });

  // Disjoint purposes are only worth having if the route actually enforces them.
  it('refuses a booking-view or checkout token presented as a return token', async () => {
    const app = createApp();
    const b = await book(app);
    expect((await ret(app, signBookingToken(b.id, SECRET))).status).toBe(401);
    expect((await ret(app, signCheckoutToken(b.id, SECRET, Date.now()))).status).toBe(401);
  });

  it('404s for a token naming a booking that does not exist', async () => {
    const app = createApp();
    expect((await ret(app, signPayReturnToken('11111111-2222-3333-4444-555555555555', SECRET))).status).toBe(404);
  });

  // Before any checkout: the customer has a booking but no payment attempt at all.
  it('reports pending, with the reference, before any payment attempt', async () => {
    const app = createApp();
    const b = await book(app);
    const res = await ret(app, signPayReturnToken(b.id, SECRET));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', reference: b.reference, sandbox: true });
  });

  // THE case the spec exists for: the customer came back and the webhook has settled them.
  it('reports paid once the payment has succeeded', async () => {
    const adapter = new FakePaymentAdapter();
    const app = createApp({ adapter });
    const b = await book(app);
    const co = await (await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: 'pay-link' }),
    })).json();
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: co.amount, currency: co.currency }),
    });
    const res = await ret(app, signPayReturnToken(b.id, SECRET));
    expect(await res.json()).toMatchObject({ status: 'paid' });
  });

  // A decline must not read as "still confirming" forever — that is the whole of D6.
  it('reports failed when the attempt was declined', async () => {
    const adapter = new FakePaymentAdapter();
    const app = createApp({ adapter });
    const b = await book(app);
    const co = await (await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo: 'pay-link' }),
    })).json();
    await app.request('/webhooks/payments', {
      method: 'POST',
      body: adapter.simulateWebhook({ orderId: b.reference, amount: co.amount, currency: co.currency, status: 'failed' }),
    });
    const res = await ret(app, signPayReturnToken(b.id, SECRET));
    expect(await res.json()).toMatchObject({ status: 'failed' });
  });

  // It authorises reading a status and nothing else — no customer details, no trip, no amounts.
  // `sandbox` is the payment GATEWAY's mode (this deployment's adapter), not booking data: the
  // same for every booking on the server, and what manage.html's purchase gate needs to keep a
  // sandbox settlement out of GA4 revenue (review of #774, finding 6).
  it('leaks nothing beyond the status, the reference and the gateway mode', async () => {
    const app = createApp();
    const b = await book(app);
    const body = await (await ret(app, signPayReturnToken(b.id, SECRET))).json();
    expect(Object.keys(body).sort()).toEqual(['reference', 'sandbox', 'status']);
  });

  describe('sandbox — the gateway mode, from the payment adapter', () => {
    const payhere = (mode: 'sandbox' | 'live') => new PayHerePaymentAdapter('1211149', 'secret', {
      mode, notifyUrl: 'https://api.example.com/webhooks/payments',
      returnUrl: 'https://example.com/booking.html', cancelUrl: 'https://example.com/booking.html',
    });
    it.each([
      { name: 'the fake gateway', make: () => new FakePaymentAdapter(), sandbox: true },
      { name: 'PayHere sandbox', make: () => payhere('sandbox'), sandbox: true },
      { name: 'PayHere live', make: () => payhere('live'), sandbox: false },
    ])('$name → sandbox: $sandbox', async ({ make, sandbox }) => {
      const app = createApp({ adapter: make() });
      const b = await book(app);
      const body = await (await ret(app, signPayReturnToken(b.id, SECRET))).json();
      expect(body.sandbox).toBe(sandbox);
    });
  });
});
