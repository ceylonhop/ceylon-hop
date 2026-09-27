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

  // A decline must not read as "still confirming" forever — that is the whole of D6. Since
  // 2026-09-26 that is the CANCEL leg's answer only (see the leg tests below): on the return leg a
  // decline may belong to an earlier attempt, so it keeps "confirming".
  it('reports failed when the attempt was declined (cancel leg)', async () => {
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
    const res = await ret(app, signPayReturnToken(b.id, SECRET, 'cancel'));
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

// Since #792, a PayHere decline is recorded and moves the payment to `failed`. PayHere lets the
// payer retry on its own page ("Try Again") and our pages let them retry too, so a `failed` row
// can belong to an EARLIER attempt while the latest one was approved. If the browser lands back
// before the approval's notify is settled, answering `failed` makes the page say "no charge was
// made — try again below" to someone who just paid, and PayHere accepts a second payment on the
// same order. PayHere sends the payer to return_url after an approval and to cancel_url after a
// cancel ("Back to Site"), so only the cancel leg may call a decline final; the return leg keeps
// "confirming" until the money lands or the page's own poll budget runs out.
describe('GET /bookings/pay-return: a decline is only final on the cancel leg', () => {
  const SITE = 'https://site.example.com';
  const PAY = 'https://pay.example.com';
  const payhere = () => new PayHerePaymentAdapter('1211149', 'secret', {
    mode: 'sandbox',
    notifyUrl: 'https://api.example.com/webhooks/payments',
    returnUrl: 'https://default.example.com/booking.html',
    cancelUrl: 'https://default.example.com/booking.html?cancelled=1',
  });
  const notify = (app: ReturnType<typeof createApp>, body: string) =>
    app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
  const rtOf = (url: string) => new URL(url).searchParams.get('rt') as string;

  async function checkedOut(returnTo: 'manage' | 'pay-link') {
    const adapter = payhere();
    const app = createApp({ adapter, bookingBaseUrl: SITE, payBaseUrl: PAY });
    const b = await book(app);
    const co = await (await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ returnTo }),
    })).json() as { fields: Record<string, string> };
    return { app, adapter, b, fields: co.fields, returnRt: rtOf(co.fields.return_url), cancelRt: rtOf(co.fields.cancel_url) };
  }
  const checkedOutFields = checkedOut;
  // PayHere's real decline shape: status -2 with payment_id "0" (no payment was created).
  const decline = (adapter: PayHerePaymentAdapter, b: { reference: string; total: number; currency: string }) =>
    adapter.simulateNotify({ orderId: b.reference, amount: b.total, currency: b.currency, statusCode: '-2', paymentId: '0' });

  for (const returnTo of ['manage', 'pay-link'] as const) {
    describe(`${returnTo} checkout`, () => {
      it('gives the return leg and the cancel leg different tokens', async () => {
        const { returnRt, cancelRt } = await checkedOut(returnTo);
        expect(returnRt).not.toBe(cancelRt);
      });

      // PayHere stores both URLs and walks them through its redirect; its length limit is not
      // documented. The URLs in use before the legs existed (return 200, cancel 204 chars) are
      // proven to work, so the cancel leg must not grow: exactly the return URL plus "&c=1".
      it('keeps the cancel URL exactly as long as the return URL plus "&c=1"', async () => {
        const { fields } = await checkedOutFields(returnTo);
        expect(fields.cancel_url.length).toBe(fields.return_url.length + '&c=1'.length);
      });

      it('answers `failed` on the cancel leg after a decline', async () => {
        const { app, adapter, b, cancelRt } = await checkedOut(returnTo);
        await notify(app, decline(adapter, b));
        expect(await (await ret(app, cancelRt)).json()).toMatchObject({ status: 'failed' });
      });

      it('keeps the return leg at `pending` after a decline: the latest attempt may have been approved', async () => {
        const { app, adapter, b, returnRt } = await checkedOut(returnTo);
        await notify(app, decline(adapter, b));
        expect(await (await ret(app, returnRt)).json()).toMatchObject({ status: 'pending' });
      });

      it('answers `paid` on both legs once a retry succeeds', async () => {
        const { app, adapter, b, returnRt, cancelRt } = await checkedOut(returnTo);
        await notify(app, decline(adapter, b));
        await notify(app, adapter.simulateNotify({ orderId: b.reference, amount: b.total, currency: b.currency, paymentId: '320000000001' }));
        expect(await (await ret(app, returnRt)).json()).toMatchObject({ status: 'paid' });
        expect(await (await ret(app, cancelRt)).json()).toMatchObject({ status: 'paid' });
      });
    });
  }

  // Tokens minted before this change are the return-leg format, so a payer mid-checkout across a
  // deploy gets the cautious answer, never a premature "declined".
  it('treats a token minted before the leg existed as the return leg', async () => {
    const { app, adapter, b } = await checkedOut('manage');
    await notify(app, decline(adapter, b));
    expect(await (await ret(app, signPayReturnToken(b.id, SECRET))).json()).toMatchObject({ status: 'pending' });
  });
});
