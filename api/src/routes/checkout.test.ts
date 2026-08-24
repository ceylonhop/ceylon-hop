import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { isoToday } from '../domain/dateRules';
import { signCheckoutToken, verifyPayReturnToken } from '../lib/bookingToken';
import { FakePaymentAdapter, type PaymentAdapter, type CreateCheckoutArgs } from '../adapters/payments';

const SECRET = 'dev-booking-link-secret-change-me';

// Dates safely in the future (past-date rejection floors bookings at today, Asia/Colombo).
const SOON = isoToday('Asia/Colombo', new Date(Date.now() + 30 * 86_400_000));
const SOON2 = isoToday('Asia/Colombo', new Date(Date.now() + 32 * 86_400_000));

const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
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

function checkout(app: ReturnType<typeof createApp>, booking: { id: string; checkoutToken: string }) {
  return app.request(`/bookings/${booking.id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${booking.checkoutToken}` },
  });
}

describe('POST /bookings/:id/checkout', () => {
  it('returns checkout params matching the booking and moves it to payment_pending', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    const params = await res.json();
    expect(params.amount).toBe(b.total);
    expect(params.orderId).toBe(b.reference);
    expect(verifyPayReturnToken(params.payReturnToken, SECRET)).toBe(b.id);
    const after = await bookings.get(b.id);
    expect(after!.status).toBe('payment_pending');
  });

  // What the payer sees named on their PayHere receipt. Owner, 2026-08-02: an unfamiliar line
  // on a card statement is a chargeback waiting to happen, so the charge should say who we are
  // and which booking it is. (The statement descriptor itself is PayHere's to set — their
  // Checkout API has no parameter for it — but this is the half we control.)
  it('names the business and the booking on the charge', async () => {
    const inner = new FakePaymentAdapter();
    let seen: CreateCheckoutArgs | null = null;
    const adapter: PaymentAdapter = {
      provider: inner.provider,
      createCheckout: (args) => { seen = args; return inner.createCheckout(args); },
      parseWebhook: (raw) => inner.parseWebhook(raw),
    };
    const app = createApp({ adapter });
    const b = await book(app);
    await checkout(app, b);
    expect(seen!.items).toBe(`Ceylon Hop Travel - ${b.reference}`);
  });

  it('404 for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request('/bookings/nope/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken('nope', SECRET)}` },
    });
    expect(res.status).toBe(404);
  });
});

describe('POST /bookings/:id/checkout — due now amount', () => {
  const chauffeur = {
    stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
    nights: [1, 2, 0],
    dates: [SOON, SOON2],
    pax: 2,
    vehicleType: 'car',
    serviceType: 'chauffeur',
    customer: valid.customer,
  };

  it('charges the full amount for a chauffeur trip', async () => {
    const app = createApp();
    const b = await (
      await app.request('/bookings/trip', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chauffeur),
      })
    ).json();
    expect(b.total).toBe(19900); // raw 20263¢ → eligible $199 charm price
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(19900);
  });

  it('falls back to the full total for legacy rows without amountDueNow', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    // simulate a pre-GL-3 row: amount_due_now is null in the DB
    (await bookings.get(b.id))!.amountDueNow = null;
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).amount).toBe(b.total);
  });
});

describe('POST /bookings/:id/checkout — status gate', () => {
  it('409s a checkout for a cancelled booking (never hand a dead booking a live charge)', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    await bookings.setStatus(b.id, 'cancelled'); // ops cancelled it before payment
    const res = await checkout(app, b);
    expect(res.status).toBe(409);
    expect((await bookings.get(b.id))!.status).toBe('cancelled'); // untouched
  });

  it('409s a second checkout once the booking is already paid', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const b = await book(app);
    await checkout(app, b); // payment_pending
    await bookings.setStatus(b.id, 'paid'); // settled
    const res = await checkout(app, b);
    expect(res.status).toBe(409);
  });
});

// The redirect checkout's return leg (spec: docs/checkout-redirect-spec.md §D3/§D4/§5.4).
// A pay-link customer leaves for PayHere and must come back to the PAY page — not to
// booking.html, which is where the adapter's constructor URLs point.
describe('POST /bookings/:id/checkout — return URLs for a pay-link checkout', () => {
  function spy() {
    const inner = new FakePaymentAdapter();
    const box: { seen: CreateCheckoutArgs | null } = { seen: null };
    const adapter: PaymentAdapter = {
      provider: inner.provider,
      createCheckout: (args) => { box.seen = args; return inner.createCheckout(args); },
      parseWebhook: (raw) => inner.parseWebhook(raw),
    };
    return { adapter, box };
  }

  function checkoutWith(app: ReturnType<typeof createApp>, b: { id: string; checkoutToken: string }, body: unknown) {
    return app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  it('names no return URLs at all for a website checkout, keeping the adapter default', async () => {
    const { adapter, box } = spy();
    const app = createApp({ adapter, payBaseUrl: 'https://pay.example.com' });
    const b = await book(app);
    await checkout(app, b);
    expect(box.seen!.returnUrl).toBeUndefined();
    expect(box.seen!.cancelUrl).toBeUndefined();
  });

  it('sends the customer back to the pay page when the checkout says it came from a pay link', async () => {
    const { adapter, box } = spy();
    const app = createApp({ adapter, payBaseUrl: 'https://pay.example.com' });
    const b = await book(app);
    await checkoutWith(app, b, { returnTo: 'pay-link' });
    expect(box.seen!.returnUrl).toMatch(/^https:\/\/pay\.example\.com\/pay\.html\?rt=/);
    expect(box.seen!.cancelUrl).toMatch(/^https:\/\/pay\.example\.com\/pay\.html\?rt=/);
  });

  // The token in the return URL must be the purpose-scoped one, verifiable back to THIS booking.
  it('carries a pay-return token that resolves to this booking and nothing else', async () => {
    const { adapter, box } = spy();
    const app = createApp({ adapter, payBaseUrl: 'https://pay.example.com' });
    const b = await book(app);
    await checkoutWith(app, b, { returnTo: 'pay-link' });
    const rt = new URL(box.seen!.returnUrl!).searchParams.get('rt');
    expect(verifyPayReturnToken(rt ?? undefined, SECRET)).toBe(b.id);
  });

  // An attacker-supplied return URL on a payment page is a phishing primitive: the customer
  // would be sent somewhere hostile by the payment gateway itself, mid-transaction.
  it('ignores a client-supplied URL — the server builds it, the client only states intent', async () => {
    const { adapter, box } = spy();
    const app = createApp({ adapter, payBaseUrl: 'https://pay.example.com' });
    const b = await book(app);
    await checkoutWith(app, b, { returnTo: 'pay-link', returnUrl: 'https://evil.example/steal' });
    expect(box.seen!.returnUrl).toMatch(/^https:\/\/pay\.example\.com\//);
    expect(box.seen!.cancelUrl).toMatch(/^https:\/\/pay\.example\.com\//);
  });

  // A body-less POST is exactly what booking.html sends today; it must keep working untouched.
  it('still works with no body at all', async () => {
    const { adapter } = spy();
    const app = createApp({ adapter, payBaseUrl: 'https://pay.example.com' });
    const b = await book(app);
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
  });
});
