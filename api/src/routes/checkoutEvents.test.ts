import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { PayHerePaymentAdapter } from '../adapters/payhere';
import type { MapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryBookingCheckoutEventRepo, type BookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import { futureIsoDate } from '../testSupport/dates';
import { signCheckoutToken, signPayReturnToken } from '../lib/bookingToken';

// ────────────────────────────────────────────────────────────────────────────
//  Booking checkout attempt log (0055). Audit 2026-09-24: every incomplete PayHere payment in 60
//  days ended silently — a customer (CH-8UVYG) reached the gateway twice, pressed "Try again"
//  twice, and nothing on our side recorded any of it. Every write below is best-effort: the
//  response a customer gets must be byte-identical with the log present, absent, or broken.
// ────────────────────────────────────────────────────────────────────────────

const SECRET = 'dev-booking-link-secret-change-me';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';

const valid = {
  from: 'Colombo Airport (CMB)',
  to: 'Ella',
  date: futureIsoDate(30),
  time: '09:00',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

type App = ReturnType<typeof createApp>;

const post = (app: App, path: string, body: unknown, headers: Record<string, string> = {}) =>
  app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
    body: JSON.stringify(body),
  });

async function book(app: App, overrides: Record<string, unknown> = {}) {
  const res = await post(app, '/bookings/single', { ...valid, ...overrides });
  expect(res.status).toBe(201);
  return res.json();
}

const checkout = (app: App, b: { id: string; checkoutToken: string }, token = b.checkoutToken) =>
  app.request(`/bookings/${b.id}/checkout`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'user-agent': UA },
  });

// A log whose every write fails, to prove the request never notices.
const brokenLog: BookingCheckoutEventRepo = {
  record: () => Promise.reject(new Error('log is down')),
  listByBookingId: async () => [],
};

describe('POST /bookings/single|trip|shared → create events', () => {
  it('records a 201 as create/succeeded with the booking’s id, reference and channel', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const b = await book(app);
    const rows = checkoutEvents.all();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      action: 'create', outcome: 'succeeded', source: 'server', httpStatus: 201,
      bookingId: b.id, reference: b.reference, channel: 'website', reason: null, ua: UA,
    });
  });

  it('records a 4xx as create/refused with the error code as the reason and no booking', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const res = await post(app, '/bookings/single', { ...valid, date: '2020-01-01' });
    expect(res.status).toBe(400);
    expect(checkoutEvents.all()).toEqual([
      expect.objectContaining({ action: 'create', outcome: 'refused', reason: 'date_in_past', httpStatus: 400, bookingId: null, source: 'server' }),
    ]);
  });

  it('records a throw as create/error and the customer still gets the usual 500', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const bookings = new InMemoryBookingRepo();
    bookings.create = () => Promise.reject(new Error('db exploded'));
    const app = createApp({ checkoutEvents, bookings });
    const res = await post(app, '/bookings/single', valid);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'internal_error' });
    expect(checkoutEvents.all()).toEqual([
      expect.objectContaining({ action: 'create', outcome: 'error', httpStatus: 500, reason: 'db exploded' }),
    ]);
  });

  it('covers the trip and shared doors too', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const trip = await post(app, '/bookings/trip', {
      serviceType: 'private', stops: ['Colombo Airport (CMB)', 'Kandy'], nights: [1, 0], dates: [futureIsoDate(30)],
      pax: 2, vehicleType: 'car', customer: valid.customer,
    });
    expect(trip.status).toBe(201);
    const shared = await post(app, '/bookings/shared', { ...valid, seats: 1 });
    expect(shared.status).toBe(400);
    expect(checkoutEvents.all().map((r) => [r.action, r.outcome, r.httpStatus])).toEqual([
      ['create', 'succeeded', 201],
      ['create', 'refused', 400],
    ]);
  });

  it('does not record an idempotent replay as a second create', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    await post(app, '/bookings/single', valid, { 'idempotency-key': 'k-1' });
    const replay = await post(app, '/bookings/single', valid, { 'idempotency-key': 'k-1' });
    expect(replay.status).toBe(200);
    expect(checkoutEvents.all()).toHaveLength(1);
  });

  it('answers exactly as before when the log is broken or absent', async () => {
    const withBroken = await post(createApp({ checkoutEvents: brokenLog }), '/bookings/single', valid);
    const without = await post(createApp(), '/bookings/single', valid);
    expect(withBroken.status).toBe(201);
    expect(Object.keys(await withBroken.json()).sort()).toEqual(Object.keys(await without.json()).sort());
  });
});

describe('POST /bookings/:id/checkout → checkout events + attempt counter', () => {
  it('records a 200 as checkout/succeeded with the order id and the attempt number, and returns it', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ checkoutEvents, payments });
    const b = await book(app);
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.attempt).toBe(1);
    expect(body.orderId).toBe(b.reference);
    const rows = checkoutEvents.all().filter((r) => r.action === 'checkout');
    expect(rows).toEqual([
      expect.objectContaining({
        outcome: 'succeeded', httpStatus: 200, bookingId: b.id, reference: b.reference, orderId: b.reference,
        channel: 'website', attempt: 1, source: 'server', ua: UA,
      }),
    ]);
    const [p] = await payments.findByBookingId(b.id);
    expect(p!.attemptCount).toBe(1);
    expect(p!.lastAttemptAt).toBeInstanceOf(Date);
  });

  it('counts a retry on the reused payment row: attempt 2, one more row', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ checkoutEvents, payments });
    const b = await book(app);
    await checkout(app, b);
    const again = await checkout(app, b);
    expect(again.status).toBe(200);
    expect((await again.json()).attempt).toBe(2);
    expect(await payments.findByBookingId(b.id)).toHaveLength(1);
    expect((await payments.findByBookingId(b.id))[0]!.attemptCount).toBe(2);
    expect(checkoutEvents.all().filter((r) => r.action === 'checkout').map((r) => r.attempt)).toEqual([1, 2]);
  });

  it('records a bad token as checkout/refused (checkout_unauthorized) against the booking id', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const b = await book(app);
    const res = await checkout(app, b, signCheckoutToken(b.id, 'other-secret'));
    expect(res.status).toBe(401);
    expect(checkoutEvents.all().filter((r) => r.action === 'checkout')).toEqual([
      expect.objectContaining({ outcome: 'refused', reason: 'checkout_unauthorized', httpStatus: 401, bookingId: b.id }),
    ]);
  });

  it('records not_found for an id that is not even a uuid, without pretending it is a booking', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const res = await app.request('/bookings/nope/checkout', {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken('nope', SECRET)}` },
    });
    expect(res.status).toBe(404);
    expect(checkoutEvents.all()).toEqual([
      expect.objectContaining({ action: 'checkout', outcome: 'refused', reason: 'not_found', httpStatus: 404, bookingId: null }),
    ]);
  });

  it('records not_chargeable, awaiting_price and already_paid by name', async () => {
    // not_chargeable: the booking moved on.
    const events1 = new InMemoryBookingCheckoutEventRepo();
    const bookings = new InMemoryBookingRepo();
    const app1 = createApp({ checkoutEvents: events1, bookings });
    const b1 = await book(app1);
    await bookings.setStatus(b1.id, 'cancelled');
    expect((await checkout(app1, b1)).status).toBe(409);
    expect(events1.all().at(-1)).toMatchObject({ action: 'checkout', outcome: 'refused', reason: 'not_chargeable', httpStatus: 409 });

    // awaiting_price: a Maps outage left the booking unpriced.
    const outageMaps: MapsAdapter = {
      provider: 'outage',
      places: async () => [],
      distanceVariants: async () => null,
      distance: async () => ({ km: 179, durationMin: 255, estimated: true }),
    };
    const events2 = new InMemoryBookingCheckoutEventRepo();
    const app2 = createApp({ checkoutEvents: events2, maps: outageMaps });
    const b2 = await book(app2, { from: 'Colombo City', to: 'Ella' });
    expect((await checkout(app2, b2)).status).toBe(409);
    expect(events2.all().at(-1)).toMatchObject({ action: 'checkout', outcome: 'refused', reason: 'awaiting_price', httpStatus: 409 });

    // already_paid: the payment settled but the booking's status lags (a paid booking is
    // refused as not_chargeable one check earlier), and the customer pressed pay again.
    const payments = new InMemoryPaymentRepo();
    const events3 = new InMemoryBookingCheckoutEventRepo();
    const app3 = createApp({ checkoutEvents: events3, payments });
    const b3 = await book(app3);
    await checkout(app3, b3);
    await payments.markSucceeded((await payments.findByBookingId(b3.id))[0]!.id);
    expect((await checkout(app3, b3)).status).toBe(409);
    expect(events3.all().at(-1)).toMatchObject({ action: 'checkout', outcome: 'refused', reason: 'already_paid', httpStatus: 409 });
  });

  it('checks out exactly as before when the log is broken', async () => {
    const app = createApp({ checkoutEvents: brokenLog });
    const b = await book(app);
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).attempt).toBe(1);
  });

  it('still checks out (without an attempt number) when the counter itself fails', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const payments = new InMemoryPaymentRepo();
    payments.touchAttempt = () => Promise.reject(new Error('column missing'));
    const app = createApp({ checkoutEvents, payments });
    const b = await book(app);
    const res = await checkout(app, b);
    expect(res.status).toBe(200);
    expect((await res.json()).attempt).toBeUndefined();
    expect(checkoutEvents.all().at(-1)).toMatchObject({ action: 'checkout', outcome: 'succeeded', attempt: null });
  });
});

describe('GET /bookings/pay-return → return events', () => {
  it('records what it answered: pending, settled, failed', async () => {
    const adapter = new FakePaymentAdapter();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents, adapter });
    const ret = (b: { id: string }) =>
      app.request(`/bookings/pay-return?rt=${encodeURIComponent(signPayReturnToken(b.id, SECRET))}`, { headers: { 'user-agent': UA } });

    const b = await book(app);
    await checkout(app, b);
    expect((await (await ret(b)).json()).status).toBe('pending');
    await app.request('/webhooks/payments', { method: 'POST', body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }) });
    expect((await (await ret(b)).json()).status).toBe('paid');

    const b2 = await book(app);
    await checkout(app, b2);
    await app.request('/webhooks/payments', { method: 'POST', body: adapter.simulateWebhook({ orderId: b2.reference, amount: b2.total, currency: b2.currency, status: 'failed' }) });
    expect((await (await ret(b2)).json()).status).toBe('failed');

    const returns = checkoutEvents.all().filter((r) => r.action === 'return');
    expect(returns.map((r) => [r.bookingId, r.outcome, r.httpStatus])).toEqual([
      [b.id, 'pending', 200],
      [b.id, 'settled', 200],
      [b2.id, 'failed', 200],
    ]);
    expect(returns[0]).toMatchObject({ reference: b.reference, source: 'server', ua: UA });
  });

  // Review of #774, finding 2. manage.html and pay.html poll every 2s for up to a minute, and a
  // "3ds Authentication Failed" decline never gets a notify — so a single return used to write ~30
  // identical `pending` rows. The log wants what CHANGED: one row per booking per status.
  it('records a status once per booking, however often the page polls for it', async () => {
    const adapter = new FakePaymentAdapter();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents, adapter });
    const ret = (b: { id: string }) =>
      app.request(`/bookings/pay-return?rt=${encodeURIComponent(signPayReturnToken(b.id, SECRET))}`);

    const b = await book(app);
    await checkout(app, b);
    for (let i = 0; i < 5; i++) expect((await (await ret(b)).json()).status).toBe('pending');
    await app.request('/webhooks/payments', { method: 'POST', body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }) });
    expect((await (await ret(b)).json()).status).toBe('paid');
    expect((await (await ret(b)).json()).status).toBe('paid');

    const returns = checkoutEvents.all().filter((r) => r.action === 'return');
    expect(returns.map((r) => [r.bookingId, r.outcome])).toEqual([[b.id, 'pending'], [b.id, 'settled']]);

    // A different booking polling the same status is its own first time.
    const b2 = await book(app);
    await ret(b2);
    await ret(b2);
    expect(checkoutEvents.all().filter((r) => r.action === 'return' && r.bookingId === b2.id)).toHaveLength(1);
  });
});

describe('POST /webhooks/payments → webhook events', () => {
  const payhere = () =>
    new PayHerePaymentAdapter('1234567', 'test-secret', {
      mode: 'sandbox',
      notifyUrl: 'https://example.com/webhooks/payments',
      returnUrl: 'https://example.com/return',
      cancelUrl: 'https://example.com/cancel',
    });
  const notify = (app: App, body: string) =>
    app.request('/webhooks/payments', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': 'PayHere-Notify/1.0' },
      body,
    });

  it('records settled (2), failed (-2), dismissed (-1) and pending (0) by PayHere status, with the order id', async () => {
    const adapter = payhere();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ checkoutEvents, adapter, bookings });
    const b = await book(app);
    await checkout(app, b);
    const sim = (statusCode: string, paymentId: string) =>
      adapter.simulateNotify({ orderId: b.reference, amount: b.total, currency: 'USD', statusCode, paymentId });

    expect((await notify(app, sim('0', 'p0'))).status).toBe(200);
    expect((await notify(app, sim('-1', 'p1'))).status).toBe(200);
    expect((await notify(app, sim('-2', 'p2'))).status).toBe(200);
    expect((await notify(app, sim('2', 'p3'))).status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('paid');

    const rows = checkoutEvents.all().filter((r) => r.action === 'webhook');
    expect(rows.map((r) => r.outcome)).toEqual(['pending', 'dismissed', 'failed', 'settled']);
    expect(rows[3]).toMatchObject({
      orderId: b.reference, bookingId: b.id, reference: b.reference, httpStatus: 200, source: 'server', ua: 'PayHere-Notify/1.0',
    });
  });

  it('records a body refused at or before the signature as refused, with the rejection reason', async () => {
    const adapter = payhere();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents, adapter });
    const signed = adapter.simulateNotify({ orderId: 'CH-ABC12', amount: 4000, currency: 'USD' });
    expect((await notify(app, signed.replace(/md5sig=[A-F0-9]{32}/, `md5sig=${'A'.repeat(32)}`))).status).toBe(401);
    expect((await notify(app, signed.replace('status_code=2', 'status_code=9'))).status).toBe(401);
    expect(checkoutEvents.all().map((r) => [r.action, r.outcome, r.reason, r.orderId, r.httpStatus])).toEqual([
      ['webhook', 'refused', 'signature_mismatch', 'CH-ABC12', 401],
      ['webhook', 'refused', 'status_code_unknown', 'CH-ABC12', 401],
    ]);
  });

  it('records a verified notify for an order we do not know as refused (unknown_order)', async () => {
    const adapter = payhere();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents, adapter });
    const res = await notify(app, adapter.simulateNotify({ orderId: 'CH-NOPE1', amount: 4000, currency: 'USD' }));
    expect(res.status).toBe(404);
    expect(checkoutEvents.all()).toEqual([
      expect.objectContaining({ action: 'webhook', outcome: 'refused', reason: 'unknown_order', orderId: 'CH-NOPE1', httpStatus: 404 }),
    ]);
  });

  it('does not log the empty liveness probe, and settles exactly as before with a broken log', async () => {
    const adapter = new FakePaymentAdapter();
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents, adapter });
    expect((await app.request('/webhooks/payments', { method: 'POST', body: '' })).status).toBe(401);
    expect(checkoutEvents.all()).toEqual([]);

    const bookings = new InMemoryBookingRepo();
    const broken = createApp({ checkoutEvents: brokenLog, adapter, bookings });
    const b = await book(broken);
    await checkout(broken, b);
    const res = await broken.request('/webhooks/payments', { method: 'POST', body: adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }) });
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('paid');
  });
});

describe('POST /bookings/:id/checkout-events (the browser’s report of the PayHere SDK)', () => {
  const beacon = (app: App, id: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(`/bookings/${id}/checkout-events`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    });

  it('records a gateway event from the client with the reason, attempt and user agent (token in the body)', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const b = await book(app);
    const res = await beacon(app, b.id, {
      outcome: 'error', reason: 'PH-0014 Unauthorized payment request. Hash mismatch.', attempt: 2, token: b.checkoutToken,
    });
    expect(res.status).toBe(204);
    expect(checkoutEvents.all().filter((r) => r.action === 'gateway')).toEqual([
      expect.objectContaining({
        outcome: 'error', reason: 'PH-0014 Unauthorized payment request. Hash mismatch.', attempt: 2, source: 'client',
        bookingId: b.id, reference: b.reference, orderId: b.reference, channel: 'website', ua: UA, httpStatus: null,
      }),
    ]);
  });

  it('accepts the token as a bearer header too, for the keepalive-fetch fallback', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const b = await book(app);
    expect((await beacon(app, b.id, { outcome: 'opened' }, { authorization: `Bearer ${b.checkoutToken}` })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'dismissed', token: b.checkoutToken })).status).toBe(204);
    expect(checkoutEvents.all().filter((r) => r.action === 'gateway').map((r) => r.outcome)).toEqual(['opened', 'dismissed']);
  });

  it('answers 204 and records nothing for a bad token, another booking’s token, a bad body, or garbage', async () => {
    const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
    const app = createApp({ checkoutEvents });
    const b = await book(app);
    const other = await book(app);
    expect((await beacon(app, b.id, { outcome: 'error', token: 'nope' })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'error', token: other.checkoutToken })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'error', token: signCheckoutToken(b.id, 'other-secret') })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'error' })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'settled', token: b.checkoutToken })).status).toBe(204);
    expect((await beacon(app, b.id, { outcome: 'error', reason: 'x'.repeat(201), token: b.checkoutToken })).status).toBe(204);
    expect((await beacon(app, b.id, '{not json')).status).toBe(204);
    expect(checkoutEvents.all().filter((r) => r.action === 'gateway')).toEqual([]);
  });

  it('answers 204 even when the log is broken', async () => {
    const app = createApp({ checkoutEvents: brokenLog });
    const b = await book(app);
    expect((await beacon(app, b.id, { outcome: 'opened', token: b.checkoutToken })).status).toBe(204);
  });
});
