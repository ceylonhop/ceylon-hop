// Add-ons after booking (spec 2026-11-14 §7.1): the booking detail's new fields and the two
// routes ops uses to send and cancel an add-on request. One test per error code.
import { describe, it, expect, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { createApp, type AppDeps } from '../app';
import { InMemoryBookingRepo, websitePricingSnapshot, type Booking, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { InMemoryAddOnRepo } from '../db/addOnRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { InMemoryCustomerCommunicationRepo } from '../db/customerCommunicationRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { CHECKOUT_TOKEN_TTL_MS } from '../lib/bookingToken';
import { quote as priceQuote } from '../quote/engine';
import { EXTRA_CODES, RATE_CARD } from '../quote/rateCard';
import { EXTRA_LABELS } from '../quote/extrasDeposit';
import { ratesFromCard } from '../quote/rateRevision';
import type { QuoteRequest } from '../quote/types';

const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,o@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function hdr(email = 'o@x.com', extra: Record<string, string> = {}) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const cookie = (await c.request('/')).headers.get('set-cookie')!.split(';')[0]!;
  return { cookie, 'content-type': 'application/json', ...extra };
}

// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
// The code card's add-on prices, and a price as the emails print it.
const price = RATE_CARD.extras as Record<string, number>;
const usd = (cents: number) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
const customer = { firstName: 'Anna', lastName: 'Berg', email: 'anna@example.com', whatsapp: '+46700000000', country: 'Sweden' };

// Kandy → Ella → Yala → Galle, the customer taking Ella → Yala themselves: two legs we drive.
const trip = (dates = [inDays(10), '', inDays(14)]): NewBooking => ({
  mode: 'trip',
  input: {
    stops: ['Kandy', 'Ella', 'Yala', 'Galle'], nights: [1, 1, 1, 0], dates,
    gaps: [1], pax: 2, vehicleType: 'car', serviceType: 'private', customer,
  },
  total: 24000, amountDueNow: 24000, currency: 'USD',
});
const single = (date: string | undefined = inDays(10)): NewBooking => ({
  mode: 'single',
  input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, date, time: '09:00', customer },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});

type Line = { id: string; legId: string; code: string; label: string; amountCents: number };
type RequestJson = {
  id: string; seq: number; name: string; status: string; state: string; totalCents: number; currency: string;
  orderId: string; payable: boolean; payLink: string | null; inFlightUntil: string | null; refundedCents: number;
  createdBy: string; createdAt: string; paidAt: string | null;
  cancelledBy: string | null; cancelledAt: string | null; cancelReason: string | null; lines: Line[];
};
type Leg = { id: string; seq: number; kind: string; from: string; to: string; viaStops: string[]; travelDate: string | null };
type Detail = {
  payLink: string | null; legs: Leg[]; addOnRequests: RequestJson[];
  addOnCatalogue?: Array<{ code: string; label: string; priceCents: number }>;
};

describe('add-ons after booking: the ops API', () => {
  let bookings: InMemoryBookingRepo;
  let payments: InMemoryPaymentRepo;
  let refunds: InMemoryRefundRepo;
  let addOns: InMemoryAddOnRepo;
  let email: FakeEmailAdapter;
  let app: ReturnType<typeof createApp>;

  const build = (over: AppDeps = {}) => createApp({
    bookings, payments, refunds, addOns, rideOps: new InMemoryRideOpsRepo(), email, auth, adminApiKey: 'adminkey',
    payBaseUrl: 'https://pay.example', bookingLinkSecret: 'sek', ...over,
  });

  beforeEach(() => {
    bookings = new InMemoryBookingRepo();
    payments = new InMemoryPaymentRepo();
    refunds = new InMemoryRefundRepo(bookings, payments);
    addOns = new InMemoryAddOnRepo(bookings, payments);
    email = new FakeEmailAdapter();
    app = build();
  });

  async function booked(nb: NewBooking = trip(), status: 'paid' | 'payment_pending' = 'paid', opts?: Parameters<InMemoryBookingRepo['create']>[1]): Promise<Booking> {
    const b = await bookings.create(nb, opts);
    await bookings.setStatus(b.id, 'payment_pending');
    return status === 'paid' ? bookings.setStatus(b.id, 'paid') : (await bookings.get(b.id))!;
  }
  const detail = async (id: string, as = 'o@x.com'): Promise<Detail> => {
    const res = await app.request(`/admin/ops/bookings/${id}`, { headers: await hdr(as) });
    expect(res.status).toBe(200);
    return res.json();
  };
  const driven = async (id: string) => (await detail(id)).legs.filter((l) => l.kind === 'leg');
  const create = async (id: string, body: unknown, as = 'o@x.com', extra: Record<string, string> = {}) =>
    app.request(`/admin/ops/bookings/${id}/add-ons`, { method: 'POST', headers: await hdr(as, extra), body: JSON.stringify(body) });
  const cancel = async (id: string, requestId: string, body: unknown = { reason: 'Customer changed their mind' }, as = 'o@x.com', extra: Record<string, string> = {}) =>
    app.request(`/admin/ops/bookings/${id}/add-ons/${requestId}/cancel`, { method: 'POST', headers: await hdr(as, extra), body: JSON.stringify(body) });
  // Sends one request and returns it; fails the test when the API refuses.
  const sent = async (id: string, lines: Array<{ legId: string; code: string }>, notifyCustomer = false): Promise<RequestJson> => {
    const res = await create(id, { lines, notifyCustomer });
    expect(res.status).toBe(200);
    return (await res.json()).request;
  };
  const refusal = async (res: Response | Promise<Response>) => {
    const r = await res;
    return [r.status, (await r.json()).error];
  };

  describe('GET /admin/ops/bookings/:id', () => {
    it('adds the stored legs, the requests and the catalogue for a private paid booking', async () => {
      const b = await booked();
      const d = await detail(b.id);
      expect(d.legs).toEqual([
        { id: expect.any(String), seq: 1, kind: 'leg', from: 'Kandy', to: 'Ella', viaStops: [], travelDate: inDays(10) },
        { id: expect.any(String), seq: 2, kind: 'gap', from: 'Ella', to: 'Yala', viaStops: [], travelDate: null },
        { id: expect.any(String), seq: 3, kind: 'leg', from: 'Yala', to: 'Galle', viaStops: [], travelDate: inDays(14) },
      ]);
      expect(d.addOnRequests).toEqual([]);
      expect(d.addOnCatalogue).toEqual(
        EXTRA_CODES.map((code) => ({ code, label: EXTRA_LABELS[code], priceCents: RATE_CARD.extras[code] })),
      );
      // The booking's own pay link is untouched: still null once the booking is paid.
      expect(d.payLink).toBeNull();
    });

    it('leaves the catalogue out when a request cannot be created, and still lists the legs', async () => {
      const pending = await booked(trip(), 'payment_pending');
      const d = await detail(pending.id);
      expect(d.addOnCatalogue).toBeUndefined();
      expect(d.legs).toHaveLength(3);
      expect(d.addOnRequests).toEqual([]);
      expect(d.payLink).toContain('/manage.html?t='); // unchanged behaviour for an unpaid booking

      const shared = await booked({
        mode: 'shared',
        input: { corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Sigiriya / Dambulla', date: inDays(10), time: '07:00', seats: 2, customer },
        total: 4800, amountDueNow: 4800, currency: 'USD',
      } as NewBooking);
      const s = await detail(shared.id);
      expect(s.addOnCatalogue).toBeUndefined();
      expect(s.legs).toEqual([]);
    });

    it('returns one request exactly in the agreed shape', async () => {
      const b = await booked();
      const [kandyElla] = await driven(b.id);
      await sent(b.id, [{ legId: kandyElla!.id, code: 'sightseeing' }]);
      const d = await detail(b.id);
      expect(d.addOnRequests).toEqual([{
        id: expect.any(String), seq: 1, name: 'A1', status: 'open', state: 'awaiting_payment',
        totalCents: price.sightseeing, currency: 'USD', orderId: `${b.reference}-A1`,
        payable: true, payLink: expect.stringMatching(/^https:\/\/pay\.example\/manage\.html\?t=.+#add-ons$/),
        inFlightUntil: null, refundedCents: 0,
        createdBy: 'o@x.com', createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T.+Z$/), paidAt: null,
        cancelledBy: null, cancelledAt: null, cancelReason: null,
        lines: [{ id: expect.any(String), legId: kandyElla!.id, code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: price.sightseeing }],
      }]);
    });

    it('carries a pay link only while the request is payable', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect(req.payLink).toMatch(/#add-ons$/);
      await bookings.setStatus(b.id, 'cancelled');
      expect((await detail(b.id)).addOnRequests[0]).toMatchObject({ state: 'cancelled_with_booking', payable: false, payLink: null });
    });

    it('carries inFlightUntil only while a checkout is in flight', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect((await detail(b.id)).addOnRequests[0]!.inFlightUntil).toBeNull();

      const p = await payments.create({
        bookingId: b.id, provider: 'fake', orderId: req.orderId, amount: req.totalCents, currency: 'USD',
        idempotencyKey: `checkout:${b.id}:addon:${req.id}`, purpose: 'add_on',
      });
      await addOns.attachPayment(req.id, p.id);
      await payments.touchAttempt(p.id);
      const attempt = (await payments.findByBookingId(b.id)).find((x) => x.id === p.id)!.lastAttemptAt!;
      expect((await detail(b.id)).addOnRequests[0]!.inFlightUntil).toBe(new Date(attempt.getTime() + CHECKOUT_TOKEN_TTL_MS).toISOString());

      // The checkout failed: nothing is in flight any more.
      await payments.markFailed(p.id);
      expect((await detail(b.id)).addOnRequests[0]!.inFlightUntil).toBeNull();
    });

    it('finance sees the requests', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      const d = await detail(b.id, 'fin@x.com');
      expect(d.addOnRequests.map((r) => r.name)).toEqual(['A1']);
      expect(d.legs).toHaveLength(3);
    });
  });

  describe('POST /admin/ops/bookings/:id/add-ons', () => {
    it('sends one line: saves the request, emails the customer and shows it on the booking', async () => {
      const b = await booked(single());
      const [leg] = await driven(b.id);
      const res = await create(b.id, { lines: [{ legId: leg!.id, code: 'sightseeing' }], notifyCustomer: true });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.emailed).toBe(true);
      expect(body.request).toMatchObject({
        seq: 1, name: 'A1', status: 'open', state: 'awaiting_payment', totalCents: price.sightseeing, currency: 'USD',
        orderId: `${b.reference}-A1`, payable: true, createdBy: 'o@x.com',
        lines: [{ legId: leg!.id, code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Colombo Airport (CMB) → Galle', amountCents: price.sightseeing }],
      });
      expect(email.sent.map((m) => m.subject)).toEqual([`An add-on for your trip: pay ${usd(price.sightseeing!)} to confirm · ${b.reference}`]);
      expect(email.sent[0]!.html).toContain(body.request.payLink);
      expect((await detail(b.id)).addOnRequests).toEqual([body.request]);
      // The original sale is never rewritten.
      expect(await bookings.get(b.id)).toMatchObject({ total: 12100, status: 'paid' });
    });

    it('ticks under two legs make one request, one total', async () => {
      const b = await booked();
      const [kandyElla, yalaGalle] = await driven(b.id);
      const req = await sent(b.id, [
        { legId: yalaGalle!.id, code: 'safari-wait' },
        { legId: kandyElla!.id, code: 'waiting' },
        { legId: kandyElla!.id, code: 'sightseeing' },
      ]);
      expect(req.lines.map((l) => [l.label, l.amountCents])).toEqual([
        ['Sightseeing stops (up to 3h) — Kandy → Ella', price.sightseeing],
        ['Waiting fee — Kandy → Ella', price.waiting],
        ['Wait for Safari — Yala → Galle', price['safari-wait']],
      ]);
      expect(req.totalCents).toBe(price.sightseeing! + price.waiting! + price['safari-wait']!);
      expect((await detail(b.id)).addOnRequests).toHaveLength(1);
    });

    it('prices from the live card, including a revision saved on the Rates page', async () => {
      const rateRevisions = new InMemoryRateRevisionRepo();
      const base = ratesFromCard(RATE_CARD);
      const rev = await rateRevisions.create({ rates: { ...base, extrasCents: { ...base.extrasCents, waiting: price.waiting! + 500 } }, baseVersion: null, createdBy: 'f@x.com' });
      app = build({ rateRevisions });
      const b = await booked();
      const [leg] = await driven(b.id);
      expect((await detail(b.id)).addOnCatalogue!.find((a) => a.code === 'waiting')!.priceCents).toBe(price.waiting! + 500);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect(req.totalCents).toBe(price.waiting! + 500);
      expect((await addOns.get(req.id))!.rateCardVersion).toBe(rev.version);
    });

    it('takes the price and the label from the server, never from the body', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const res = await create(b.id, { lines: [{ legId: leg!.id, code: 'waiting', amountCents: 1, label: 'Free' }], notifyCustomer: false });
      expect((await res.json()).request.lines[0]).toMatchObject({ label: 'Waiting fee — Kandy → Ella', amountCents: price.waiting });
    });

    it('does not email when the operator unticks it', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const res = await create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: false });
      expect((await res.json()).emailed).toBe(false);
      expect(email.sent).toHaveLength(0);
    });

    it('still saves when the email throws, and says the customer was not emailed', async () => {
      app = build({ email: { send: async () => { throw new Error('provider down'); } } });
      const b = await booked();
      const [leg] = await driven(b.id);
      const res = await create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: true });
      expect(res.status).toBe(200);
      expect((await res.json()).emailed).toBe(false);
      expect(await addOns.listByBooking(b.id)).toHaveLength(1);
    });

    it('says not emailed when the email is held back', async () => {
      app = build({ emailPolicy: { enabled: false } });
      const b = await booked();
      const [leg] = await driven(b.id);
      const res = await create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: true });
      expect((await res.json()).emailed).toBe(false);
      expect(email.sent).toHaveLength(0);
    });

    it('two requests on one booking are two rows in the email ledger', async () => {
      const customerCommunications = new InMemoryCustomerCommunicationRepo();
      app = build({ customerCommunications, communicationTrackingEnabled: true });
      const b = await booked();
      const [kandyElla, yalaGalle] = await driven(b.id);
      const first = await sent(b.id, [{ legId: kandyElla!.id, code: 'waiting' }], true);
      const second = await sent(b.id, [{ legId: yalaGalle!.id, code: 'waiting' }], true);
      expect(second).toMatchObject({ seq: 2, name: 'A2', orderId: `${b.reference}-A2` });
      const rows = await customerCommunications.listByBookingId(b.id);
      expect(rows.map((r) => [r.kind, r.trackingKey]).sort()).toEqual([
        ['add_on_request', `${b.id}:add_on_request:${first.id}`],
        ['add_on_request', `${b.id}:add_on_request:${second.id}`],
      ].sort());
      expect(rows.every((r) => r.source === 'ops' && r.actorType === 'staff')).toBe(true);
    });

    it('the ops and founder roles can send; finance cannot', async () => {
      const b = await booked();
      const [kandyElla, yalaGalle] = await driven(b.id);
      expect((await create(b.id, { lines: [{ legId: kandyElla!.id, code: 'waiting' }], notifyCustomer: false }, 'o@x.com')).status).toBe(200);
      expect((await create(b.id, { lines: [{ legId: yalaGalle!.id, code: 'waiting' }], notifyCustomer: false }, 'f@x.com')).status).toBe(200);
      expect((await create(b.id, { lines: [{ legId: kandyElla!.id, code: 'luggage' }], notifyCustomer: false }, 'fin@x.com')).status).toBe(403);
      expect(await addOns.listByBooking(b.id)).toHaveLength(2);
    });

    it('refuses a request with no session, and a cross-site one (CSRF)', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const body = { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: false };
      const anonymous = await app.request(`/admin/ops/bookings/${b.id}/add-ons`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      expect(anonymous.status).toBe(401);
      expect((await create(b.id, body, 'o@x.com', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect(await addOns.listByBooking(b.id)).toHaveLength(0);
    });

    it('400s a malformed body', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const line = { legId: leg!.id, code: 'waiting' };
      for (const body of [
        null,
        { lines: [], notifyCustomer: false },
        { lines: [line] }, // notifyCustomer is required: the operator decides
        { lines: [{ legId: 'not-a-uuid', code: 'waiting' }], notifyCustomer: false },
        { lines: [{ legId: leg!.id }], notifyCustomer: false },
        { lines: Array.from({ length: 25 }, () => line), notifyCustomer: false },
      ]) {
        expect(await refusal(create(b.id, body)), JSON.stringify(body)).toEqual([400, 'bad_request']);
      }
      expect(await addOns.listByBooking(b.id)).toHaveLength(0);
    });

    it('404s an unknown or malformed booking id', async () => {
      const body = { lines: [{ legId: randomUUID(), code: 'waiting' }], notifyCustomer: false };
      expect(await refusal(create(randomUUID(), body))).toEqual([404, 'not_found']);
      expect(await refusal(create('not-a-uuid', body))).toEqual([404, 'not_found']);
    });

    // ── The ten create errors (spec §7.1) ─────────────────────────────────
    it('not_private: a chauffeur trip', async () => {
      const b = await booked({ ...trip(), input: { ...trip().input, serviceType: 'chauffeur', gaps: [], days: 4 } } as NewBooking);
      const legs = (await detail(b.id)).legs;
      expect(await refusal(create(b.id, { lines: [{ legId: legs[0]!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'not_private']);
    });

    it('booking_not_eligible: a booking that is not paid yet', async () => {
      const b = await booked(trip(), 'payment_pending');
      const [leg] = await driven(b.id);
      expect(await refusal(create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'booking_not_eligible']);
    });

    it('awaiting_price: a booking the engine could not price', async () => {
      const b = await booked({ ...single(), needsPricing: true });
      const [leg] = await driven(b.id);
      expect(await refusal(create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'awaiting_price']);
    });

    it('legs_missing: a booking with no stored legs', async () => {
      const b = await booked({ ...trip(), input: { ...trip().input, stops: ['Kandy'], nights: [0], dates: [], gaps: [] } } as NewBooking);
      expect((await detail(b.id)).legs).toEqual([]);
      expect(await refusal(create(b.id, { lines: [{ legId: randomUUID(), code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'legs_missing']);
    });

    it('leg_not_found: a leg id that is not one of this booking’s, even another booking’s', async () => {
      const b = await booked();
      const other = await booked(single());
      const [otherLeg] = await driven(other.id);
      expect(await refusal(create(b.id, { lines: [{ legId: randomUUID(), code: 'waiting' }], notifyCustomer: false }))).toEqual([404, 'leg_not_found']);
      expect(await refusal(create(b.id, { lines: [{ legId: otherLeg!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([404, 'leg_not_found']);
    });

    it('leg_not_driven: a stretch the customer covers themselves', async () => {
      const b = await booked();
      const gap = (await detail(b.id)).legs.find((l) => l.kind === 'gap')!;
      expect(await refusal(create(b.id, { lines: [{ legId: gap.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'leg_not_driven']);
    });

    it('leg_passed: a leg whose day is over, while a later leg still takes one', async () => {
      const b = await booked(trip([inDays(-2), '', inDays(3)]));
      const [past, coming] = await driven(b.id);
      expect(await refusal(create(b.id, { lines: [{ legId: past!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'leg_passed']);
      expect((await create(b.id, { lines: [{ legId: coming!.id, code: 'waiting' }], notifyCustomer: false })).status).toBe(200);
    });

    it('unknown_add_on: a code the catalogue does not sell, such as a shared-only one', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      for (const code of ['nope', 'hotel-pickup']) {
        expect(await refusal(create(b.id, { lines: [{ legId: leg!.id, code }], notifyCustomer: false })), code).toEqual([400, 'unknown_add_on']);
      }
    });

    it('duplicate_add_on: the same add-on twice on one leg, in one body or across two requests', async () => {
      const b = await booked();
      const [kandyElla, yalaGalle] = await driven(b.id);
      const line = { legId: kandyElla!.id, code: 'waiting' };
      expect(await refusal(create(b.id, { lines: [line, line], notifyCustomer: false }))).toEqual([409, 'duplicate_add_on']);
      await sent(b.id, [line]);
      expect(await refusal(create(b.id, { lines: [line], notifyCustomer: false }))).toEqual([409, 'duplicate_add_on']);
      // The same add-on on another leg, and another add-on on the same leg, are both fine.
      await sent(b.id, [{ legId: yalaGalle!.id, code: 'waiting' }, { legId: kandyElla!.id, code: 'luggage' }]);
      expect(await addOns.listByBooking(b.id)).toHaveLength(2);
    });

    describe('already_bought_at_booking', () => {
      // A website booking names its add-ons from its own priced lines.
      const snapshot = (engine: QuoteRequest) => ({ pricingSnapshot: websitePricingSnapshot({ engine, result: priceQuote(engine, RATE_CARD) }) });

      it('refuses, on a one-leg booking, an add-on bought with the trip', async () => {
        const engine: QuoteRequest = {
          product: 'private', vehicle: 'car', pax: 2, bags: 2,
          legs: [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 150 }],
          extras: [{ code: 'sightseeing' }, { code: 'waiting', legIndex: 0 }],
        };
        const b = await booked(single(), 'paid', snapshot(engine));
        expect((await bookings.get(b.id))!.addOns).toEqual(['Sightseeing stops (up to 3h)', 'Waiting fee — Colombo Airport (CMB) → Galle']);
        const [leg] = await driven(b.id);
        expect(await refusal(create(b.id, { lines: [{ legId: leg!.id, code: 'sightseeing' }], notifyCustomer: false }))).toEqual([409, 'already_bought_at_booking']);
        expect(await refusal(create(b.id, { lines: [{ legId: leg!.id, code: 'waiting' }], notifyCustomer: false }))).toEqual([409, 'already_bought_at_booking']);
        expect((await create(b.id, { lines: [{ legId: leg!.id, code: 'luggage' }], notifyCustomer: false })).status).toBe(200);
      });

      it('lets it through on a multi-leg booking, where the add-on cannot be tied to a leg', async () => {
        const engine: QuoteRequest = {
          product: 'private', vehicle: 'car', pax: 2, bags: 2,
          legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }, { from: 'Yala', to: 'Galle', distanceKm: 170 }],
          extras: [{ code: 'sightseeing' }],
        };
        const b = await booked(trip(), 'paid', snapshot(engine));
        expect((await bookings.get(b.id))!.addOns).toEqual(['Sightseeing stops (up to 3h)']);
        const [leg] = await driven(b.id);
        expect((await create(b.id, { lines: [{ legId: leg!.id, code: 'sightseeing' }], notifyCustomer: false })).status).toBe(200);
      });
    });
  });

  describe('POST /admin/ops/bookings/:id/add-ons/:requestId/cancel', () => {
    it('cancels an open request with a reason, and frees the add-on to be sent again', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      const res = await cancel(b.id, req.id, { reason: '  Customer changed their mind  ' });
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body.request).toMatchObject({
        id: req.id, status: 'cancelled', state: 'cancelled', payable: false, payLink: null,
        cancelledBy: 'o@x.com', cancelledAt: expect.any(String), cancelReason: 'Customer changed their mind',
      });
      expect((await detail(b.id)).addOnRequests).toEqual([body.request]);
      expect(await sent(b.id, [{ legId: leg!.id, code: 'waiting' }])).toMatchObject({ seq: 2, name: 'A2' });
    });

    // ── The three cancel errors (spec §7.1) ───────────────────────────────
    it('already_paid: a paid request is refunded, not cancelled', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      addOns.markPaidForSettlement(req.id, new Date());
      expect(await refusal(cancel(b.id, req.id))).toEqual([409, 'already_paid']);
    });

    it('not_open: a request that was already cancelled', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect((await cancel(b.id, req.id)).status).toBe(200);
      expect(await refusal(cancel(b.id, req.id))).toEqual([409, 'not_open']);
    });

    it('payment_in_flight: the customer opened the payment form in the last 30 minutes', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      const p = await payments.create({
        bookingId: b.id, provider: 'fake', orderId: req.orderId, amount: req.totalCents, currency: 'USD',
        idempotencyKey: `checkout:${b.id}:addon:${req.id}`, purpose: 'add_on',
      });
      await addOns.attachPayment(req.id, p.id);
      await payments.touchAttempt(p.id);
      expect(await refusal(cancel(b.id, req.id))).toEqual([409, 'payment_in_flight']);
      expect((await addOns.get(req.id))!.status).toBe('open');
    });

    it('404s a request that belongs to another booking, or to none', async () => {
      const b = await booked();
      const other = await booked(single());
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect(await refusal(cancel(other.id, req.id))).toEqual([404, 'request_not_found']);
      expect(await refusal(cancel(b.id, randomUUID()))).toEqual([404, 'request_not_found']);
      expect(await refusal(cancel(b.id, 'not-a-uuid'))).toEqual([404, 'request_not_found']);
      expect(await refusal(cancel(randomUUID(), req.id))).toEqual([404, 'not_found']);
      expect((await addOns.get(req.id))!.status).toBe('open');
    });

    it('requires a reason of 1 to 300 characters', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      for (const body of [null, {}, { reason: '' }, { reason: '   ' }, { reason: 'x'.repeat(301) }]) {
        expect(await refusal(cancel(b.id, req.id, body)), JSON.stringify(body)).toEqual([400, 'bad_request']);
      }
      expect((await cancel(b.id, req.id, { reason: 'x'.repeat(300) })).status).toBe(200);
    });

    it('finance cannot cancel, and a cross-site request is refused (CSRF)', async () => {
      const b = await booked();
      const [leg] = await driven(b.id);
      const req = await sent(b.id, [{ legId: leg!.id, code: 'waiting' }]);
      expect((await cancel(b.id, req.id, { reason: 'no' }, 'fin@x.com')).status).toBe(403);
      expect((await cancel(b.id, req.id, { reason: 'no' }, 'o@x.com', { 'sec-fetch-site': 'cross-site' })).status).toBe(403);
      expect((await addOns.get(req.id))!.status).toBe('open');
      expect((await cancel(b.id, req.id, { reason: 'no' }, 'f@x.com')).status).toBe(200);
    });
  });
});
