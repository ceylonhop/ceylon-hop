import { describe, expect, it } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import {
  CHECKOUT_TOKEN_TTL_MS,
  signBookingToken,
  signCheckoutToken,
  verifyCheckoutToken,
} from '../lib/bookingToken';

const SECRET = 'checkout-capability-test-secret';
const START = Date.UTC(2026, 6, 28, 12);
const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+94770000000',
  country: 'Sri Lanka',
};
const input = {
  from: 'Colombo Airport (CMB)',
  to: 'Galle',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 1,
  customer,
};

function create(now: () => number, extra: Parameters<typeof createApp>[0] = {}) {
  return createApp({
    bookingLinkSecret: SECRET,
    checkoutNow: now,
    ...extra,
  });
}

async function book(app: ReturnType<typeof createApp>, key?: string) {
  const response = await app.request('/bookings/single', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(key ? { 'idempotency-key': key } : {}),
    },
    body: JSON.stringify(input),
  });
  return { response, body: await response.json() };
}

function checkout(app: ReturnType<typeof createApp>, id: string, token?: string) {
  return app.request(`/bookings/${id}/checkout`, {
    method: 'POST',
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe('checkout capability issuance and enforcement', () => {
  it('issues a 30-minute token without persisting it in the booking', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = create(() => START, { bookings });
    const { body } = await book(app);
    expect(verifyCheckoutToken(body.checkoutToken, body.id, SECRET, START)).toBe(true);
    expect(verifyCheckoutToken(body.checkoutToken, body.id, SECRET, START + CHECKOUT_TOKEN_TTL_MS))
      .toBe(false);
    expect(await bookings.get(body.id)).not.toHaveProperty('checkoutToken');
  });

  it('issues a fresh usable token on an idempotent 200 retry', async () => {
    let now = START;
    const app = create(() => now);
    const first = await book(app, 'same-request');
    now += 60_000;
    const retry = await book(app, 'same-request');
    expect(first.response.status).toBe(201);
    expect(retry.response.status).toBe(200);
    expect(retry.body.id).toBe(first.body.id);
    expect(retry.body.checkoutToken).not.toBe(first.body.checkoutToken);
    expect(verifyCheckoutToken(retry.body.checkoutToken, retry.body.id, SECRET, now)).toBe(true);
  });

  it('rejects missing, malformed, expired, view-purpose, and wrong-booking tokens', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = create(() => START, { bookings });
    const { body } = await book(app);
    const wrongBooking = signCheckoutToken('another-booking', SECRET, START);
    const expired = signCheckoutToken(body.id, SECRET, START - CHECKOUT_TOKEN_TTL_MS);
    const view = signBookingToken(body.id, SECRET);

    for (const token of [undefined, 'malformed', expired, view, wrongBooking]) {
      const response = await checkout(app, body.id, token);
      expect(response.status).toBe(401);
      expect((await response.json()).error).toBe('checkout_unauthorized');
    }
    expect((await bookings.get(body.id))?.status).toBe('draft');
  });

  it('uses a valid token for the exact existing checkout amount', async () => {
    const app = create(() => START);
    const { body } = await book(app);
    const response = await checkout(app, body.id, body.checkoutToken);
    expect(response.status).toBe(200);
    expect((await response.json()).amount).toBe(body.amountDueNow);
  });

  it('checks authorization before revealing whether a booking exists', async () => {
    const app = create(() => START);
    expect((await checkout(app, 'unknown')).status).toBe(401);
    const validForUnknown = signCheckoutToken('unknown', SECRET, START);
    expect((await checkout(app, 'unknown', validForUnknown)).status).toBe(404);
  });

  it('legacy compatibility accepts only an absent token, never an invalid supplied token', async () => {
    const app = create(() => START, { allowLegacyCheckoutWithoutToken: true });
    const first = await book(app);
    expect((await checkout(app, first.body.id)).status).toBe(200);

    const second = await book(app);
    expect((await checkout(app, second.body.id, 'invalid')).status).toBe(401);
  });
});

describe('POST /bookings/view/checkout-token', () => {
  it('exchanges a permanent view token only while the booking is chargeable', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = create(() => START, { bookings });
    const { body } = await book(app);
    const viewToken = signBookingToken(body.id, SECRET);
    const exchange = () =>
      app.request('/bookings/view/checkout-token', {
        method: 'POST',
        headers: { authorization: `Bearer ${viewToken}` },
      });

    const response = await exchange();
    expect(response.status).toBe(200);
    const issued = await response.json();
    expect(verifyCheckoutToken(issued.checkoutToken, body.id, SECRET, START)).toBe(true);

    await bookings.setStatus(body.id, 'cancelled');
    const refused = await exchange();
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toBe('not_chargeable');
  });

  it('rejects missing/invalid view credentials and an unknown signed booking', async () => {
    const app = create(() => START);
    expect((await app.request('/bookings/view/checkout-token', { method: 'POST' })).status)
      .toBe(401);
    expect(
      (
        await app.request('/bookings/view/checkout-token', {
          method: 'POST',
          headers: { authorization: 'Bearer invalid' },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await app.request('/bookings/view/checkout-token', {
          method: 'POST',
          headers: { authorization: `Bearer ${signBookingToken('unknown', SECRET)}` },
        })
      ).status,
    ).toBe(404);
  });
});
