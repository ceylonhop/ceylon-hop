import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

async function hdr() {
  return { cookie: await cookie('f@x.com'), 'content-type': 'application/json' }; // founder session
}

function bookingInput(overrides: { travelDate?: string } = {}) {
  return {
    mode: 'single' as const, total: 12100, amountDueNow: 12100, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car' as const, adults: 2, children: 0, bags: 1,
      date: overrides.travelDate ?? '2026-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  };
}

async function seed(bookings: InMemoryBookingRepo, overrides: { travelDate?: string } = {}) {
  return bookings.create(bookingInput(overrides));
}

describe('ops bookings endpoints', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let bid: string;
  let rideOps: InMemoryRideOpsRepo;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    rideOps = new InMemoryRideOpsRepo();
    app = createApp({ bookings, rideOps, auth, adminApiKey: 'adminkey' });
    bid = (await seed(bookings)).id;
    await bookings.setStatus(bid, 'payment_pending');
  });

  it('lists bookings as ops rows', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('Colombo Airport → Galle');
    expect(rows[0].stage).toBe('awaiting_payment'); // freshly created booking is draft/payment_pending
  });

  it('advances fulfilment status via the status endpoint', async () => {
    await bookings.setStatus(bid, 'paid');
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    const ops = await res.json();
    expect(ops.fulfilmentStatus).toBe('vehicle_confirmed');
  });

  it('records the staff and fulfilment milestone mirrored to the booking', async () => {
    const tracked = new InMemoryBookingRepo({ transitionTrackingEnabled: true });
    const trackedRideOps = new InMemoryRideOpsRepo();
    const trackedApp = createApp({ bookings: tracked, rideOps: trackedRideOps, auth, adminApiKey: 'adminkey' });
    const b = await seed(tracked);
    await tracked.setStatus(b.id, 'payment_pending', undefined, { source: 'website', actorType: 'customer' });
    await tracked.setStatus(b.id, 'paid', undefined, { source: 'payment_webhook', actorType: 'provider' });

    expect((await trackedApp.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'vehicle_confirmed' }),
    })).status).toBe(200);
    expect((await tracked.listStatusEvents(b.id))[2]).toMatchObject({
      fromStatus: 'paid', toStatus: 'confirmed', source: 'ops', actorType: 'staff', actorId: 'f@x.com',
      reason: 'fulfilment:vehicle_confirmed', relatedEntityType: 'fulfilment', relatedEntityId: b.id,
    });
  });

  it('rejects an illegal status transition with 400', async () => {
    await bookings.setStatus(bid, 'paid');
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'completed' }),
    });
    expect(res.status).toBe(400);
  });

  it('toggles flags', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/flags`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ vehiclePhotoReceived: true }),
    });
    expect((await res.json()).vehiclePhotoReceived).toBe(true);
  });

  it('returns 400 (not a 500 that pages the founder) on a malformed status/flags body', async () => {
    const status = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ wrong: 'field' }),
    });
    expect(status.status).toBe(400);
    const flags = await app.request(`/admin/ops/bookings/${bid}/flags`, {
      method: 'POST', headers: await hdr(), body: 'not json',
    });
    expect(flags.status).toBe(400);
  });

  it('lists every post-cart booking as the ops queue, ordered by travel date', async () => {
    const paid = await seed(bookings, { travelDate: '2026-07-10' });
    await bookings.setStatus(paid.id, 'payment_pending');
    await bookings.setStatus(paid.id, 'paid');

    const pending = await seed(bookings, { travelDate: '2026-07-05' });
    await bookings.setStatus(pending.id, 'payment_pending');

    const draft = await seed(bookings); // stays draft — excluded
    void draft;

    const completed = await seed(bookings, { travelDate: '2026-07-01' });
    await bookings.setStatus(completed.id, 'payment_pending');
    await bookings.setStatus(completed.id, 'paid');
    await bookings.setStatus(completed.id, 'confirmed');
    await bookings.setStatus(completed.id, 'in_progress');
    await bookings.setStatus(completed.id, 'completed'); // closed, but still listed

    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const rows = await res.json();
    // Queue = bid (payment_pending, travelDate 2026-06-22, from beforeEach) + completed +
    // pending + paid. Only `draft` is excluded — a half-finished web cart is not ops work.
    // A closed booking stays listed so it can still be opened; the UI files it under Closed.
    expect(rows).toHaveLength(4);
    expect(rows[0].id).toBe(bid);
    expect(rows[0].travelDate).toBe('2026-06-22');
    expect(rows[0].stage).toBe('awaiting_payment');
    expect(rows[1].travelDate).toBe('2026-07-01');
    expect(rows[1].id).toBe(completed.id);
    expect(rows[2].travelDate).toBe('2026-07-05');
    expect(rows[2].stage).toBe('awaiting_payment');
    expect(rows[3].travelDate).toBe('2026-07-10');
    expect(rows[3].stage).toBe('paid');
    expect(rows[0].channel).toBe('website');
    expect(rows.find((r: { id: string }) => r.id === draft.id)).toBeUndefined();
  });

  it('keeps a cancelled or refunded booking in the queue, stamped closed', async () => {
    const cancelled = await seed(bookings, { travelDate: '2026-07-02' });
    await bookings.setStatus(cancelled.id, 'payment_pending');
    await bookings.setStatus(cancelled.id, 'cancelled');

    // A refund lands on a booking whose ride_ops row had already advanced — the closed
    // status must win, or the row invites another "Confirm pickup".
    const refunded = await seed(bookings, { travelDate: '2026-07-03' });
    await bookings.setStatus(refunded.id, 'payment_pending');
    await bookings.setStatus(refunded.id, 'paid');
    await rideOps.setStatus(refunded.id, 'vehicle_confirmed');
    await bookings.setStatus(refunded.id, 'refunded');

    const rows = await (await app.request('/admin/ops/bookings', { headers: await hdr() })).json();
    const byId = (id: string) => rows.find((r: { id: string }) => r.id === id);
    expect(byId(cancelled.id).stage).toBe('cancelled');
    expect(byId(refunded.id).stage).toBe('refunded');
  });

  it('reflects ride_ops fulfilment as stage for paid bookings', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const rideOps = new InMemoryRideOpsRepo();
    const app2 = createApp({ bookings, rideOps, auth, adminApiKey: 'adminkey' });
    await rideOps.getOrCreate(b.id);
    await rideOps.setStatus(b.id, 'vehicle_confirmed');
    const res = await app2.request('/admin/ops/bookings', { headers: await hdr() });
    const rows = await res.json();
    expect(rows.find((r: { id: string }) => r.id === b.id).stage).toBe('vehicle_confirmed');
  });

  it('advances stage via POST /bookings/:id/status with the new machine', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(res.status).toBe(200);
    const bad = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'completed' }),
    });
    expect(bad.status).toBe(400);
  });

  // The ops pipeline is the only thing that drives a booking to completion, so without this
  // mirror booking.status never left 'paid': no trip was ever recorded as having happened.
  it('mirrors each fulfilment milestone onto the booking lifecycle', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const step = async (to: string, expected: string) => {
      expect((await app.request(`/admin/ops/bookings/${b.id}/status`, {
        method: 'POST', headers: await hdr(), body: JSON.stringify({ to }),
      })).status).toBe(200);
      expect((await bookings.get(b.id))!.status).toBe(expected);
    };
    await step('vehicle_confirmed', 'confirmed');
    // No booking counterpart — the money row holds still rather than inventing a transition.
    await step('pickup_confirmed', 'confirmed');
    await step('on_trip', 'in_progress');
    await step('completed', 'completed');
  });

  it('a fulfilment backtrack leaves the booking lifecycle alone', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    for (const to of ['vehicle_confirmed', 'pickup_confirmed']) {
      await app.request(`/admin/ops/bookings/${b.id}/status`, {
        method: 'POST', headers: await hdr(), body: JSON.stringify({ to }),
      });
    }
    expect((await bookings.get(b.id))!.status).toBe('confirmed');
    const back = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(back.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('confirmed'); // never walks backwards
  });

  it('mirrors a no-show, and mirroring never fails the ops action it rides on', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    const res = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: await hdr(), body: JSON.stringify({ to: 'no_show' }),
    });
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('no_show');
  });

  // The drawer's "payment link" was copy with nothing behind it — an ops-booked trip had no
  // way to reach a card form at all. This is the link ops actually pastes into WhatsApp.
  it('hands ops a payment link while the booking is chargeable, and none once it is not', async () => {
    const detail = async (id: string) => (await (await app.request(`/admin/ops/bookings/${id}`, { headers: await hdr() })).json());
    const pending = await detail(bid);
    expect(pending.payLink).toContain('/manage.html?t=');

    await bookings.setStatus(bid, 'paid');
    expect((await detail(bid)).payLink).toBeNull();
  });

  // Owner-caught (2026-08-01): with the pay domain configured, the drawer's payment link
  // still read ops.<domain>/manage.html. PR #234 moved the QUOTE pay link onto PAY_BASE_URL
  // but opsRoutes' baseUrl stayed on APP_BASE_URL — the two mints must resolve identically.
  it('the payment link leaves the ops host when a pay origin is configured', async () => {
    const app2 = createApp({ bookings, rideOps, auth, adminApiKey: 'adminkey', payBaseUrl: 'https://pay.example' });
    const res = await app2.request(`/admin/ops/bookings/${bid}`, { headers: await hdr() });
    const { payLink } = await res.json();
    expect(payLink).toMatch(/^https:\/\/pay\.example\/manage\.html\?t=/);
  });

  it('has no coordinator, manifest, or rides routes', async () => {
    for (const path of ['/admin/ops/coordinators', '/admin/ops/manifest', '/admin/ops/rides']) {
      const res = await app.request(path, { headers: await hdr() });
      expect(res.status).toBe(404);
    }
  });
});

import { FakeEmailAdapter } from '../adapters/email';
import { InMemoryNotificationLogRepo } from '../db/notificationLogRepo';

describe('ops fulfilment milestones email the customer', () => {
  function appWith(email: FakeEmailAdapter) {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({
      bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey',
      email, notificationLog: new InMemoryNotificationLogRepo(),
    });
    return { app, bookings };
  }
  async function paidBooking(bookings: InMemoryBookingRepo) {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    return b;
  }
  const post = (app: ReturnType<typeof createApp>, id: string, to: string) =>
    hdr().then((h) => app.request(`/admin/ops/bookings/${id}/status`, { method: 'POST', headers: h, body: JSON.stringify({ to }) }));

  it('does not email the customer when ops confirms the vehicle (driver-arranged email suppressed)', async () => {
    const email = new FakeEmailAdapter();
    const { app, bookings } = appWith(email);
    const b = await paidBooking(bookings);

    const res = await post(app, b.id, 'vehicle_confirmed');
    expect((await res.json()).fulfilmentStatus).toBe('vehicle_confirmed');
    expect(email.sent).toHaveLength(0);
  });

  it('sends the no-show notice on → no_show', async () => {
    const email = new FakeEmailAdapter();
    const { app, bookings } = appWith(email);
    const b = await paidBooking(bookings);
    await post(app, b.id, 'vehicle_confirmed');

    const res = await post(app, b.id, 'no_show');
    expect((await res.json()).fulfilmentStatus).toBe('no_show');
    const notice = email.sent.filter((m) => m.to === 'm@x.com' && /refundable/i.test(m.text ?? ''));
    expect(notice).toHaveLength(1);
  });

  it('a non-milestone advance (pickup_confirmed) sends no email', async () => {
    const email = new FakeEmailAdapter();
    const { app, bookings } = appWith(email);
    const b = await paidBooking(bookings);
    await post(app, b.id, 'vehicle_confirmed');
    const before = email.sent.length;
    await post(app, b.id, 'pickup_confirmed');
    expect(email.sent.length).toBe(before);
  });
});

// The queue is read on every load of the ops Bookings surface, and it holds every booking in
// the eight queue statuses — closed ones included — so it only ever grows. A payments lookup
// per booking, awaited one after another, is a round-trip per booking to a database ~100 ms
// away (prod, 2026-09-22): the whole reason the page "takes forever". Pin it to one batched
// lookup, and prove the paid flag still comes from the payments rows.
describe('ops bookings list — payments are fetched in one batch, not per booking', () => {
  it('never calls findByBookingId for the list, and still marks the paid booking paid', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const perBooking: string[] = [];
    const orig = payments.findByBookingId.bind(payments);
    payments.findByBookingId = async (id: string) => { perBooking.push(id); return orig(id); };
    const app = createApp({ bookings, payments, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey' });

    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const b = await seed(bookings);
      await bookings.setStatus(b.id, 'payment_pending');
      ids.push(b.id);
    }
    const p = await payments.create({ bookingId: ids[1], provider: 'fake', orderId: `o-${ids[1]}`, amount: 12100, currency: 'USD', idempotencyKey: `k-${ids[1]}` });
    await payments.markSucceeded(p.id);
    await bookings.setStatus(ids[1], 'paid');

    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const rows: { id: string; paymentStatus: string }[] = await res.json();

    expect(perBooking).toEqual([]);
    expect(rows.map((r) => [r.id, r.paymentStatus]).sort()).toEqual(
      [[ids[0], 'unpaid'], [ids[1], 'paid'], [ids[2], 'unpaid']].sort(),
    );
  });
});

// Test bookings (2026-09-24): every ops row says whether its customer email is one of the
// team's (TEAM_EMAILS), so the queue can label it and leave it out of its counts.
describe('ops bookings rows — isTest', () => {
  it('flags a team-email booking and leaves a customer booking unflagged', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey', teamEmails: new Set(['m@x.com']) });
    const mine = await seed(bookings);
    await bookings.setStatus(mine.id, 'payment_pending');
    const theirs = await bookings.create({
      ...bookingInput(),
      input: { ...bookingInput().input, customer: { ...bookingInput().input.customer, email: 'real@customer.example' } },
    });
    await bookings.setStatus(theirs.id, 'payment_pending');
    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const rows: Array<{ id: string; isTest: boolean }> = await res.json();
    expect(rows.find((r) => r.id === mine.id)?.isTest).toBe(true);
    expect(rows.find((r) => r.id === theirs.id)?.isTest).toBe(false);
  });

  it('is false on every row when TEAM_EMAILS is unset', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey' });
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    const res = await app.request('/admin/ops/bookings', { headers: await hdr() });
    const rows: Array<{ isTest: boolean }> = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].isTest).toBe(false);
  });
});

// A booking sold on a pay link for the CHAUFFEUR option of a "both" quote (spec PR #964) is a
// whole-trip sale: the drawer shows no "2 of 4 legs" coverage — and, above all, still opens.
const chauffeurTrip = {
  mode: 'trip' as const, total: 30000, amountDueNow: 30000, currency: 'USD',
  input: {
    stops: ['Kandy', 'Ella', 'Galle'], nights: [1, 1, 0], dates: ['2026-07-20', '2026-07-22'], pax: 2,
    vehicleType: 'car' as const, serviceType: 'chauffeur' as const, days: 3, driverNights: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' },
  },
};

describe('the booking drawer for a booking sold on a chauffeur link', () => {
  async function drawerFor(selection: object | null, booking: ReturnType<typeof bookingInput> | typeof chauffeurTrip = bookingInput()) {
    const bookings = new InMemoryBookingRepo();
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), quotes, auth, adminApiKey: 'adminkey' });
    const b = await bookings.create(booking as never);
    await bookings.setStatus(b.id, 'payment_pending');
    const q = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', totalCents: 21900, currency: 'USD', rateCardVersion: 'v1',
      request: { engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }, { from: 'B', to: 'C', distanceKm: 10 }] } },
      result: { totalCents: 21900, lineItems: [] },
    });
    await quotes.patch(q.id, { convertedBookingId: b.id, ...(selection ? { payLinkSelection: selection as never, soldCents: 30000 } : {}) });
    return app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() });
  }

  it('opens, with no coverage (it is a whole-trip sale)', async () => {
    const res = await drawerFor({ service: 'chauffeur' });
    expect(res.status).toBe(200);
    expect((await res.json()).coverage).toBeNull();
  });

  it('still reports coverage for a part-of-trip sale', async () => {
    const res = await drawerFor({ legIndexes: [0], extraIndexes: [] });
    expect(res.status).toBe(200);
    expect((await res.json()).coverage).toEqual({ soldLegs: 1, totalLegs: 2 });
  });

  // Coverage is decided by the BOOKING: a chauffeur booking is a whole-trip sale however the quote's
  // selection moved afterwards (here: re-minted to a part-of-trip link).
  it('a chauffeur booking has no coverage even when the quote now carries a part-of-trip selection', async () => {
    const res = await drawerFor({ legIndexes: [0], extraIndexes: [] }, chauffeurTrip);
    expect(res.status).toBe(200);
    expect((await res.json()).coverage).toBeNull();
  });
});

// Refund leg picker (refund approvals phase 2): the drawer carries the booking's charge lines,
// each worth its share of what the booking was charged, so ops can tick legs and the amount fills
// in. A convenience only — a founder approves every request.
import { quote as priceQuote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import { websitePricingSnapshot } from '../db/bookingRepo';
import type { QuoteRequest } from '../quote/types';

describe('the booking drawer\'s refund lines', () => {
  const engine: QuoteRequest = {
    product: 'private', vehicle: 'car', pax: 2, bags: 1,
    legs: [{ from: 'Colombo', to: 'Kandy', distanceKm: 120 }, { from: 'Kandy', to: 'Ella', distanceKm: 140 }],
    extras: [{ code: 'waiting', legIndex: 1 }],
  };
  const priced = priceQuote(engine, RATE_CARD);
  type Lines = { currency: string; lines: Array<{ kind: string; index: number; label: string; amountCents: number }> } | null;

  async function drawer(opts: { booking?: object; quote?: boolean; snapshot?: boolean; currency?: string } = {}) {
    const bookings = new InMemoryBookingRepo();
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), quotes, auth, adminApiKey: 'adminkey' });
    const input = { ...bookingInput(), total: priced.totalCents, amountDueNow: priced.totalCents, ...(opts.booking ?? {}) };
    const b = await bookings.create(input as never, opts.snapshot ? { pricingSnapshot: websitePricingSnapshot({ engine, result: { ...priced, currency: (opts.currency ?? priced.currency) as never } }) } : undefined);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    if (opts.quote) {
      const q = await quotes.save({
        channel: 'ops', product: 'private', vehicle: 'car', totalCents: priced.totalCents, currency: opts.currency ?? priced.currency, rateCardVersion: 'v1',
        request: { engine }, result: { ...priced, currency: opts.currency ?? priced.currency },
      });
      await quotes.patch(q.id, { convertedBookingId: b.id });
    }
    const res = await app.request(`/admin/ops/bookings/${b.id}`, { headers: await hdr() });
    expect(res.status).toBe(200);
    return (await res.json()).refundLines as Lines;
  }

  function expectProRated(lines: Lines) {
    expect(lines?.currency).toBe('USD');
    expect(lines?.lines.map((l) => l.label)).toEqual(['Colombo → Kandy (car)', 'Kandy → Ella (car)', expect.stringContaining('Kandy → Ella')]);
    // Each line is rounded on its own, so the sum lands within a cent per line of the charge.
    const sum = lines!.lines.reduce((a, l) => a + l.amountCents, 0);
    expect(Math.abs(sum - priced.totalCents)).toBeLessThanOrEqual(lines!.lines.length);
  }

  it('reads them from the quote the booking was converted from', async () => {
    expectProRated(await drawer({ quote: true }));
  });

  it('reads them from a website booking\'s own pricing snapshot', async () => {
    expectProRated(await drawer({ snapshot: true }));
  });

  it('has none for a booking with neither', async () => {
    expect(await drawer()).toBeNull();
  });

  it('has none for a chauffeur trip', async () => {
    expect(await drawer({ booking: chauffeurTrip, quote: true })).toBeNull();
  });

  it('has none when the priced lines are in another currency than the booking', async () => {
    expect(await drawer({ quote: true, currency: 'LKR' })).toBeNull();
  });
});
