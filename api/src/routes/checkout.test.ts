import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { isoToday } from '../domain/dateRules';
import { signCheckoutToken } from '../lib/bookingToken';
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
