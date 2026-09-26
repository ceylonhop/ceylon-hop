import { describe, it, expect, afterEach, vi } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryPaymentEventRepo } from '../db/paymentEventRepo';
import { InMemoryBookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import { InMemoryQuoteRepo, type NewQuote } from '../db/quoteRepo';
import { InMemoryRefundRepo, type Refund } from '../db/refundRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { futureIsoDate } from '../testSupport/dates';

// GET /admin/ops/cases/:ref — the ops payment lookup (spec 2026-09-26). Founder and finance only;
// read-only; a source that fails to load makes the answer incomplete, never silently empty.

const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,o@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1';

async function as(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return { cookie: res.headers.get('set-cookie')!.split(';')[0] };
}

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const draft: NewBooking = {
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: futureIsoDate(30), time: '09:00', customer },
  total: 12100, amountDueNow: 12100, currency: 'USD',
};
const quote: NewQuote = {
  product: 'private', vehicle: 'car', customerName: 'Maya', customerContact: '+34600', totalCents: 4048,
  currency: 'USD', rateCardVersion: '2026-06-28', marginCents: 900,
  request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] }, result: { totalCents: 4048 },
};

class BrokenRefunds extends InMemoryRefundRepo {
  override async list(): Promise<Refund[]> { throw new Error('refunds down'); }
}

class BrokenPersonList extends InMemoryBookingRepo {
  override async listByPersonKey(): Promise<never> { throw new Error('person list down'); }
}

function setup(over: { refunds?: InMemoryRefundRepo; bookings?: InMemoryBookingRepo } = {}) {
  const bookings = over.bookings ?? new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const paymentEvents = new InMemoryPaymentEventRepo();
  const checkoutEvents = new InMemoryBookingCheckoutEventRepo();
  const quotes = new InMemoryQuoteRepo();
  const adapter = new FakePaymentAdapter();
  const app = createApp({
    bookings, payments, paymentEvents, checkoutEvents, quotes, adapter,
    rideOps: new InMemoryRideOpsRepo(), notificationLog: new InMemoryNotificationLogRepo(),
    auth, adminApiKey: 'k', ...over,
  });
  const get = async (ref: string, email: string | null = 'f@x.com') =>
    app.request(`/admin/ops/cases/${encodeURIComponent(ref)}`, email ? { headers: await as(email) } : {});
  return { app, bookings, payments, quotes, adapter, get };
}

// A website booking taken through checkout and PayHere's (fake) notify, the way a customer's is.
async function paidBooking(s: ReturnType<typeof setup>) {
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    s.app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': UA, ...headers }, body: JSON.stringify(body) });
  const created = await post('/bookings/single', { from: 'Colombo Airport (CMB)', to: 'Ella', date: futureIsoDate(30), time: '09:00', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer });
  expect(created.status).toBe(201);
  const b = await created.json();
  const checkout = await s.app.request(`/bookings/${b.id}/checkout`, { method: 'POST', headers: { authorization: `Bearer ${b.checkoutToken}`, 'user-agent': UA } });
  expect(checkout.status).toBe(200);
  await s.app.request('/webhooks/payments', { method: 'POST', body: s.adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency }) });
  return b as { id: string; reference: string };
}

describe('GET /admin/ops/cases/:ref — access', () => {
  it('needs a session, and the payments:act capability', async () => {
    const s = setup();
    const b = await s.bookings.create(draft);
    expect((await s.get(b.reference, null)).status).toBe(401);
    expect((await s.get(b.reference, 'o@x.com')).status).toBe(403);
    expect((await s.get(b.reference, 'f@x.com')).status).toBe(200);
    expect((await s.get(b.reference, 'fin@x.com')).status).toBe(200);
  });
});

describe('GET /admin/ops/cases/:ref — lookup', () => {
  it('400 for anything that is not a booking or quote ref, 404 for an unknown one', async () => {
    const s = setup();
    const bad = await s.get('hello');
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: 'bad_ref' });
    const missing = await s.get('CH-NOPE2');
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: 'not_found' });
  });

  it('finds a draft the queue never shows, whatever the case or suffix the ref was pasted with', async () => {
    const s = setup();
    const b = await s.bookings.create(draft);
    for (const ref of [b.reference, b.reference.toLowerCase(), ` ${b.reference}-MANUAL `]) {
      const res = await s.get(ref);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).toMatchObject({
        ref: b.reference, quote: null, unavailable: [], gaps: [],
        booking: {
          id: b.id, reference: b.reference, status: 'draft', mode: 'single', channel: 'website', inQueue: false, isTest: false,
          route: 'Colombo Airport → Galle', total: 12100, amountDueNow: 12100, currency: 'USD', cancellation: null,
          customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
        },
        verdict: { kind: 'never_started' },
      });
      expect(body.timeline).toEqual([{ at: body.booking.createdAt, source: 'bookings', kind: 'created' }]);
    }
  });

  it('a quote ref opens the booking the quote became', async () => {
    const s = setup();
    const b = await s.bookings.create(draft);
    const q = await s.quotes.save(quote);
    await s.quotes.patch(q.id, { convertedBookingId: b.id });
    const body = await (await s.get(q.reference.toLowerCase())).json();
    expect(body).toMatchObject({ ref: q.reference, quote: { id: q.id, reference: q.reference, status: 'draft' }, booking: { id: b.id } });
  });

  it('a quote with no booking yet answers with the quote alone', async () => {
    const s = setup();
    const q = await s.quotes.save(quote);
    const res = await s.get(q.reference);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      ref: q.reference, quote: { id: q.id, reference: q.reference, status: 'draft' }, booking: null, verdict: null, timeline: [], gaps: [], unavailable: [],
      otherBookings: null, // a quote records no email, so there is no person to list
    });
  });

  it('shows a card payment settled through PayHere’s notify as paid, with the checkout behind it', async () => {
    const s = setup();
    const b = await paidBooking(s);
    const body = await (await s.get(b.reference)).json();
    expect(body.booking).toMatchObject({ status: 'paid', inQueue: true });
    expect(body.verdict).toMatchObject({ kind: 'paid', checkouts: 1, declineNotices: 0, payhere: { code: '2' }, warnings: [] });
    const kinds = body.timeline.map((r: { source: string; kind: string; action?: string }) => `${r.source}:${r.kind}${r.action ? ':' + r.action : ''}`);
    expect(kinds).toEqual(expect.arrayContaining(['booking_checkout_event:log:create', 'booking_checkout_event:log:checkout', 'payments:payment_created', 'payment_events:notice']));
    expect(kinds).not.toContain('booking_checkout_event:log:webhook');
    expect(kinds).not.toContain('bookings:created'); // the log's create row already says it
  });

  it('never hands out links, tokens or raw payload fingerprints', async () => {
    const s = setup();
    const b = await paidBooking(s);
    const text = await (await s.get(b.reference)).text();
    for (const secret of ['manage.html', 'checkoutToken', 'payloadSha256', 'payload_sha256', 'merchant_id', 'idempotencyKey']) {
      expect(text).not.toContain(secret);
    }
  });

  it('a source that fails to load makes the answer incomplete, not wrong', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const s = setup({ refunds: new BrokenRefunds(bookings, payments) });
    const b = await s.bookings.create(draft);
    const res = await s.get(b.reference);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ verdict: null, unavailable: ['refunds'], booking: { id: b.id } });
  });
});

describe('GET /admin/ops/cases/:ref — this customer’s other bookings (spec §15)', () => {
  const asEmail = (email: string): NewBooking => ({ ...draft, input: { ...draft.input, customer: { ...customer, email } } } as NewBooking);

  afterEach(() => { vi.useRealTimers(); });
  // Each booking gets its own minute: created in one millisecond they would tie on created_at.
  const at = (minute: number) => vi.setSystemTime(new Date(Date.UTC(2026, 8, 20, 10, minute)));

  it('lists the same person’s other bookings, newest first: drafts and cancelled included, itself left out', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const s = setup();
    at(1);
    const older = await s.bookings.create(asEmail('Maya@Example.com '));
    at(2);
    const cancelled = await s.bookings.create(draft);
    await s.bookings.setStatus(cancelled.id, 'cancelled', { reason: 'duplicate — paid on CH-XXXX2', by: 'system:duplicate-close' });
    at(3);
    await s.bookings.create(asEmail('someone@else.com'));
    at(4);
    const paidOne = await s.bookings.create(draft);
    const pay = await s.payments.create({ bookingId: paidOne.id, provider: 'payhere', orderId: paidOne.reference, amount: 12100, currency: 'USD', idempotencyKey: `checkout:${paidOne.id}` });
    await s.payments.markSucceeded(pay.id);
    at(5);
    const looked = await s.bookings.create(draft);
    vi.useRealTimers(); // the session cookie is signed against the real clock

    const body = await (await s.get(looked.reference)).json();
    expect(body.otherBookings.truncated).toBe(false);
    expect(body.otherBookings.rows.map((r: { id: string }) => r.id)).toEqual([paidOne.id, cancelled.id, older.id]);
    expect(body.otherBookings.rows[0]).toEqual({
      id: paidOne.id, reference: paidOne.reference, status: 'draft', mode: 'single', channel: 'website',
      createdAt: paidOne.createdAt, route: 'Colombo Airport → Galle', travelDate: draft.input.date, travelTime: '09:00', pax: 2,
      total: 12100, currency: 'USD', paid: true, isTest: false,
    });
    expect(body.otherBookings.rows[1]).toMatchObject({ status: 'cancelled', paid: false });
  });

  it('shows the newest 50 and says there are more', async () => {
    const s = setup();
    for (let i = 0; i < 52; i++) await s.bookings.create(draft);
    const looked = await s.bookings.create(draft);
    const body = await (await s.get(looked.reference)).json();
    expect(body.otherBookings.rows).toHaveLength(50);
    expect(body.otherBookings.truncated).toBe(true);
    expect(body.otherBookings.rows.some((r: { id: string }) => r.id === looked.id)).toBe(false);
  });

  it('a list that fails to load is null, and never costs the booking its verdict', async () => {
    const s = setup({ bookings: new BrokenPersonList() });
    const b = await s.bookings.create(draft);
    const body = await (await s.get(b.reference)).json();
    expect(body).toMatchObject({ otherBookings: null, unavailable: [], verdict: { kind: 'never_started' } });
  });
});
