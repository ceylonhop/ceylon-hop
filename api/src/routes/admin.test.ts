import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeAlertAdapter } from '../adapters/alerts';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { nextIsoWeekday, futureIsoDate } from '../testSupport/dates';
import { SENT_QUOTE_TTL_MS } from '../services/quoteExpiry';
import { Hono } from 'hono';

const KEY = 'secret-key';
const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

async function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

const valid = {
  from: 'Colombo Airport',
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

describe('GET /admin/bookings', () => {
  it('401 without any identity', async () => {
    const app = createApp({ adminApiKey: KEY, auth });
    expect((await app.request('/admin/bookings')).status).toBe(401);
  });

  it('401 with a wrong key (no identity resolved)', async () => {
    const app = createApp({ adminApiKey: KEY, auth });
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': 'nope' } });
    expect(res.status).toBe(401);
  });

  it('bookings:read — any of the 3 human roles works, no key needed', async () => {
    const app = createApp({ adminApiKey: KEY, auth });
    await book(app);
    const res = await app.request('/admin/bookings', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
    const list = await res.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(1);
  });

  it('403 for the system key (x-admin-key lacks bookings:read)', async () => {
    const app = createApp({ adminApiKey: KEY, auth });
    const res = await app.request('/admin/bookings', { headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(403);
  });
});

function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const email = new FakeEmailAdapter();
  return { app: createApp({ adminApiKey: KEY, auth, bookings, email }), bookings, email };
}

describe('POST /admin/bookings/:id/cancel', () => {
  // Cancelling moved to payments:reverse — founder only (owner, 2026-08-02). Calling a
  // customer's trip off is not something finance should be able to do alone.
  it('cancels the booking for a FOUNDER session, transitions it to cancelled, and emails the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    const sent = email.sent.filter((m) => /cancel/i.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('maya@example.com');
  });

  it('refuses a finance session — cancelling is founder-only', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(403);
    expect((await bookings.get(b.id))!.status).not.toBe('cancelled'); // untouched
  });

  it('401 without any identity', async () => {
    const { app } = makeApp();
    const b = await book(app);
    expect((await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST' })).status).toBe(401);
  });

  it('403 for the system key — the machine key can no longer issue refunds/cancels (D6)', async () => {
    const { app } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(403);
  });

  // Ops MAY cancel now (owner rule 2026-08-02): more than 24h before the trip, OR within 24h of
  // taking the booking. Every booking created through the API in these tests is seconds old, so
  // the grace applies and ops is allowed even with no trip date — which is the point of the
  // grace, since bookings frequently arrive inside 24h of travel. The AGED cases (grace expired,
  // trip imminent) need a controlled clock and live in domain/reversalWindow.test.ts.
  it('an ops session may cancel a booking it just took, even with no trip date', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('op@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.cancelledBy).toBe('op@x.com');
  });

  it('404 for an unknown booking', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/bookings/no-such/cancel', {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(404);
  });

  // ── Owner rule, 2026-08-02: ops may reverse up to 24h before the trip ───────────────────
  // Dates come from futureIsoDate(), never a literal — see docs/known-bugs.md on date bombs.
  const bookOn = async (app: ReturnType<typeof createApp>, date: string, time = '09:00') => {
    const res = await app.request('/bookings/single', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...valid, date, time }),
    });
    return res.json();
  };
  const cancelAs = async (app: ReturnType<typeof createApp>, id: string, who: string, reason = 'Customer called it off') =>
    app.request(`/admin/bookings/${id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie(who), 'content-type': 'application/json' },
      body: JSON.stringify({ reason }),
    });

  it('an OPS agent may cancel a trip that is more than 24 hours away', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(30));
    const res = await cancelAs(app, b.id, 'op@x.com');
    expect(res.status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
  });

  // A trip inside 24h is still reversible by ops HERE only because the booking is fresh. That
  // combination is exactly the same-day intake case the grace exists for.
  it('an OPS agent may cancel an imminent trip it just took', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(1), '00:00');
    expect((await cancelAs(app, b.id, 'op@x.com')).status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
  });

  it('finance may not cancel at all, however fresh the booking', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(30));
    const res = await cancelAs(app, b.id, 'fin@x.com');
    expect(res.status).toBe(403);
    expect((await bookings.get(b.id))!.status).not.toBe('cancelled');
  });

  it('a FOUNDER may cancel inside 24 hours — never time-limited', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(1), '00:00');
    expect((await cancelAs(app, b.id, 'f@x.com')).status).toBe(200);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
  });

  it('stores the reason and who gave it', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(30));
    await cancelAs(app, b.id, 'op@x.com', 'Flight cancelled by the airline');
    const saved = (await bookings.get(b.id))!;
    expect(saved.cancellationReason).toBe('Flight cancelled by the airline');
    expect(saved.cancelledBy).toBe('op@x.com');
    expect(saved.cancelledAt).toBeTruthy();
  });

  it('refuses a cancellation with no reason, and changes nothing', async () => {
    const { app, bookings } = makeApp();
    const b = await bookOn(app, futureIsoDate(30));
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('cancellation_reason_required');
    expect((await bookings.get(b.id))!.status).not.toBe('cancelled');
  });

  it('refuses a blank reason — whitespace is not an explanation', async () => {
    const { app } = makeApp();
    const b = await bookOn(app, futureIsoDate(30));
    const res = await cancelAs(app, b.id, 'f@x.com', '   ');
    expect(res.status).toBe(400);
  });

  it('the ops time window applies to refunds too, not just cancellation', async () => {
    const { app } = makeApp();
    const near = await bookOn(app, futureIsoDate(1), '00:00');
    const far = await bookOn(app, futureIsoDate(30));
    const refund = (id: string, who: string) => cookie(who).then((ck) =>
      app.request(`/admin/bookings/${id}/refunds`, {
        method: 'POST',
        headers: { cookie: ck, 'content-type': 'application/json' },
        body: JSON.stringify({ amountCents: 1000, currency: 'USD', reason: 'Customer request' }),
      }));
    // Both are fresh, so the rule lets ops through on each; the ledger then applies its own
    // business check (409 — nothing was ever captured on these unpaid bookings). Not 403 is the
    // point: the reversal gate is on the refund route, and it is the SAME gate as cancel's.
    expect((await refund(near.id, 'op@x.com')).status).toBe(409);
    expect((await refund(far.id, 'op@x.com')).status).toBe(409);
    // finance has no bookings:operate, so it never reaches the ledger at all.
    expect((await refund(far.id, 'fin@x.com')).status).toBe(403);
  });

  it('409 when the booking cannot be cancelled (already cancelled)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'cancelled');
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /admin/jobs/notifications', () => {
  it('runs the scheduler and returns counts, sending a reminder for a booking due tomorrow (system key)', async () => {
    const { app, bookings, email } = makeApp();
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const b = await bookings.create({
      mode: 'single',
      input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
      total: 5000,
      amountDueNow: 5000,
      currency: 'USD',
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).reminders).toBe(1);
    expect(email.sent.some((m) => /coming up/i.test(m.subject))).toBe(true);
  });

  it('401 without any identity', async () => {
    const { app } = makeApp();
    expect((await app.request('/admin/jobs/notifications', { method: 'POST' })).status).toBe(401);
  });

  it('403 for an ops session (no admin:jobs)', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/jobs/notifications', {
      method: 'POST', headers: { cookie: await cookie('op@x.com') },
    });
    expect(res.status).toBe(403);
  });

  it('200 for a founder session (founder also has admin:jobs)', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/jobs/notifications', {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(200);
  });

  it('sweeps stale shared holds alongside the notification tick (GL-3)', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const app = createApp({ adminApiKey: KEY, auth, bookings, departures, email: new FakeEmailAdapter() });
    await departures.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 12 });
    const b = await bookings.create({
      mode: 'shared',
      input: { corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 12, customer: valid.customer },
      total: 25200,
      amountDueNow: 25200,
      currency: 'USD',
    });
    // age the draft past the 24h hold window
    (await bookings.get(b.id))!.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect((await res.json()).staleSharedHolds).toBe(1);
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    expect(await departures.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 12 })).not.toBeNull();
  });

  it('expires stale sent ops quotes alongside the notification tick', async () => {
    vi.useFakeTimers();
    try {
      const NOW = new Date('2026-07-17T12:00:00Z');
      vi.setSystemTime(NOW);
      const quotes = new InMemoryQuoteRepo();
      const app = createApp({
        adminApiKey: KEY, auth, quotes, bookings: new InMemoryBookingRepo(), email: new FakeEmailAdapter(),
      });
      const q = await quotes.save({
        channel: 'ops', product: 'private', totalCents: 4048, currency: 'USD',
        rateCardVersion: '2026-06-28', request: {}, result: {},
      });
      // Stamp sentAt just past the idle TTL, DERIVED from the constant rather than a literal
      // "31 days": the TTL moved 30 → 180 once the team began parking real quotes in 'sent',
      // and a hardcoded age silently stops testing expiry the moment it changes again.
      vi.setSystemTime(new Date(NOW.getTime() - SENT_QUOTE_TTL_MS - 24 * 3600 * 1000));
      await quotes.patch(q.id, { status: 'sent' });
      vi.setSystemTime(NOW);

      const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
      expect(res.status).toBe(200);
      expect((await res.json()).expiredQuotes).toBe(1);
      expect((await quotes.get(q.id))?.status).toBe('expired');
    } finally {
      vi.useRealTimers();
    }
  });

  it('the notifications tick reports the abandoned-draft sweep', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ abandonedDrafts: 0 });
  });
});

describe('POST /admin/jobs/watchdog', () => {
  it('403 for a finance session (no admin:jobs)', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/jobs/watchdog', {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(403);
  });

  it('200 for the system key', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/jobs/watchdog', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(200);
  });
});

// GL-3 — cancelling/refunding a shared booking must give its seats back to the departure.
describe('shared seat release on cancel/refund', () => {
  const shared = {
    corridorId: 'hill-line', // capacity 12
    date: nextIsoWeekday(3), // a Wednesday — a shared service day (corridors run Wed & Sat)
    time: '08:00',
    seats: 12, // the whole bus, so a leaked hold is observable as a sold-out 409
    customer: valid.customer,
  };

  function makeSharedApp() {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const payments = new InMemoryPaymentRepo();
    const app = createApp({ adminApiKey: KEY, auth, bookings, departures, payments, email: new FakeEmailAdapter() });
    return { app, bookings, departures, payments };
  }

  function bookShared(app: ReturnType<typeof createApp>) {
    return app.request('/bookings/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shared),
    });
  }

  async function captureAndRequestFullRefund(
    app: ReturnType<typeof createApp>,
    payments: InMemoryPaymentRepo,
    booking: { id: string; reference: string; total: number; currency: string },
  ) {
    const payment = await payments.create({
      bookingId: booking.id,
      provider: 'payhere',
      orderId: booking.reference,
      amount: booking.total,
      currency: booking.currency,
      idempotencyKey: `shared-refund-${booking.id}`,
    });
    await payments.markSucceeded(payment.id);
    const requested = await app.request(`/admin/bookings/${booking.id}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
      body: JSON.stringify({
        amountCents: booking.total,
        currency: booking.currency,
        reason: 'Shared booking cancelled',
      }),
    });
    expect(requested.status).toBe(201);
    return requested.json();
  }

  it('cancel releases the seats — the departure can be booked again', async () => {
    const { app } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    expect((await bookShared(app)).status).toBe(409); // full while held
    await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect((await bookShared(app)).status).toBe(201); // freed by the cancel
  });

  it('refund of a paid shared booking releases the seats', async () => {
    const { app, bookings, payments } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const refund = await captureAndRequestFullRefund(app, payments, b);
    const confirmed = await app.request(`/admin/bookings/${b.id}/refunds/${refund.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
      body: JSON.stringify({ gatewayRef: 'SHARED-REFUND-1' }),
    });
    expect(confirmed.status).toBe(200);
    expect((await bookShared(app)).status).toBe(201);
  });

  it('refund after cancel does not release the seats twice', async () => {
    const { app, bookings, departures, payments } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const refund = await captureAndRequestFullRefund(app, payments, b);
    // another traveller takes 3 of the freed seats between the cancel and the refund
    await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    const other = await departures.holdSeats({ corridorId: 'hill-line', date: shared.date, time: shared.time, seats: 3 });
    expect(other?.seatsBooked).toBe(3);
    const confirmed = await app.request(`/admin/bookings/${b.id}/refunds/${refund.id}/confirm`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
      body: JSON.stringify({ gatewayRef: 'SHARED-REFUND-2' }),
    });
    expect(confirmed.status).toBe(200);
    // the other traveller's hold must survive — no second release
    const after = await departures.holdSeats({ corridorId: 'hill-line', date: shared.date, time: shared.time, seats: 1 });
    expect(after?.seatsBooked).toBe(4);
  });

  it('cancelling a non-shared booking never touches departures', async () => {
    const { app, departures } = makeSharedApp();
    const b = await book(app); // a single transfer
    const spy = vi.spyOn(departures, 'releaseSeats');
    await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /admin/bookings/:id/refund', () => {
  it('is removed so no caller can bypass the refund ledger and PayHere evidence', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/refund`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(404);
    expect((await bookings.get(b.id))!.status).toBe('paid');
  });

  it('does not leak the removed route to unauthenticated callers', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/bookings/no-such/refund', { method: 'POST' });
    expect(res.status).toBe(404);
  });
});

// Drive a freshly-booked (draft) booking through legal transitions to a target state.
async function drive(bookings: InMemoryBookingRepo, id: string, ...chain: string[]) {
  for (const s of chain) await bookings.setStatus(id, s as never);
}

describe('POST /admin/bookings/:id/confirm', () => {
  it('confirms a paid booking (paid → confirmed) without emailing the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    await drive(bookings, b.id, 'payment_pending', 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/confirm`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('confirmed');
    expect((await bookings.get(b.id))!.status).toBe('confirmed');
    expect(email.sent.filter((m) => /confirmed/i.test(m.subject))).toHaveLength(0);
  });

  it('403 for an ops session (no payments:act)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await drive(bookings, b.id, 'payment_pending', 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/confirm`, {
      method: 'POST', headers: { cookie: await cookie('op@x.com') },
    });
    expect(res.status).toBe(403);
  });

  it('409 when the booking is not paid yet (illegal transition)', async () => {
    const { app } = makeApp();
    const b = await book(app); // still draft
    const res = await app.request(`/admin/bookings/${b.id}/confirm`, {
      method: 'POST',
      headers: { cookie: await cookie('f@x.com'), 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Customer called it off' }),
    });
    expect(res.status).toBe(409);
  });
});

describe('POST /admin/bookings/:id/no-show', () => {
  it('marks a confirmed booking no_show and emails the forfeited-fare notice', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    await drive(bookings, b.id, 'payment_pending', 'paid', 'confirmed');
    const res = await app.request(`/admin/bookings/${b.id}/no-show`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('no_show');
    expect((await bookings.get(b.id))!.status).toBe('no_show');
    const sent = email.sent.filter((m) => m.to === 'maya@example.com' && /refundable/i.test(m.text ?? ''));
    expect(sent).toHaveLength(1);
  });

  it('403 for an ops session (no payments:act)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await drive(bookings, b.id, 'payment_pending', 'paid', 'confirmed');
    const res = await app.request(`/admin/bookings/${b.id}/no-show`, {
      method: 'POST', headers: { cookie: await cookie('op@x.com') },
    });
    expect(res.status).toBe(403);
  });
});

// A booking converted from an ops quote is settled by cash or bank transfer, so no PayHere
// webhook is ever coming. mark-paid RECORDS that money (it does not merely flip the status)
// so the booking can leave "Awaiting payment" AND still be refundable later.
describe('POST /admin/bookings/:id/mark-paid', () => {
  function makeCashApp() {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const rideOps = new InMemoryRideOpsRepo();
    const email = new FakeEmailAdapter();
    return { app: createApp({ adminApiKey: KEY, auth, bookings, payments, rideOps, email }), bookings, payments, rideOps, email };
  }

  // The state the ops quote → booking conversion leaves behind: "Awaiting payment".
  async function awaitingPayment(app: ReturnType<typeof createApp>, bookings: InMemoryBookingRepo) {
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    return b as { id: string; reference: string; total: number; amountDueNow?: number | null; currency: string };
  }

  const markPaid = async (app: ReturnType<typeof createApp>, id: string, body: unknown, who = 'f@x.com') =>
    app.request(`/admin/bookings/${id}/mark-paid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie(who) },
      body: JSON.stringify(body),
    });

  it('moves the booking to paid and records exactly one manually-settled payment for the amount due', async () => {
    const { app, bookings, payments, email } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    const res = await markPaid(app, b.id, { method: 'cash' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    expect((await bookings.get(b.id))!.status).toBe('paid');

    const rows = await payments.findByBookingId(b.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].provider).toBe('cash');
    expect(rows[0].amount).toBe(b.amountDueNow ?? b.total);
    expect(rows[0].currency).toBe(b.currency);
    // order_id is UNIQUE and the checkout route claims the bare reference: a booking once handed
    // a PayHere form must still settle in cash rather than 23505 in Postgres (invisible here —
    // the in-memory repo just overwrites the duplicate).
    expect(rows[0].orderId).toBe(`${b.reference}-MANUAL`);
    // Provenance (SH7): real cash must NEVER be labelled a legacy backfill or a webhook.
    const settlement = payments.getForSettlement(rows[0].id)!;
    expect(settlement.settlementSource).toBe('manual');
    expect(settlement.settledAt).toBeInstanceOf(Date);
    // Explicit owner decision (2026-07-30): no customer email on this action.
    expect(email.sent).toHaveLength(0);
  });

  it('lands the operator reference on the payment, and succeeds without one', async () => {
    const { app, bookings, payments } = makeCashApp();
    const withRef = await awaitingPayment(app, bookings);
    expect((await markPaid(app, withRef.id, { method: 'bank_transfer', reference: 'BOC-77219' })).status).toBe(200);
    const paid = (await payments.findByBookingId(withRef.id))[0];
    expect(paid.provider).toBe('bank_transfer');
    expect(payments.getForSettlement(paid.id)!.gatewayPaymentId).toBe('BOC-77219');

    const noRef = await awaitingPayment(app, bookings);
    expect((await markPaid(app, noRef.id, { method: 'cash' })).status).toBe(200);
    const cash = (await payments.findByBookingId(noRef.id))[0];
    expect(cash.status).toBe('succeeded');
    expect(payments.getForSettlement(cash.id)!.gatewayPaymentId).toBeNull();
  });

  it('leaves the booking refundable — the whole reason the money is recorded', async () => {
    const { app, bookings } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    expect((await markPaid(app, b.id, { method: 'cash' })).status).toBe(200);
    const refund = await app.request(`/admin/bookings/${b.id}/refunds`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
      body: JSON.stringify({ amountCents: b.amountDueNow ?? b.total, currency: b.currency, reason: 'Trip cancelled' }),
    });
    expect(refund.status).toBe(201); // NOT 409 payment_not_captured
  });

  it('records the operator, the method and the reference in the booking activity notes', async () => {
    const { app, bookings, rideOps } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    await markPaid(app, b.id, { method: 'bank_transfer', reference: 'BOC-77219' }, 'fin@x.com');
    const notes = (await rideOps.get(b.id))!.opsNotes ?? '';
    expect(notes).toContain('fin@x.com');
    expect(notes).toContain('bank_transfer');
    expect(notes).toContain('BOC-77219');
  });

  it('400 not_awaiting_payment for a booking that is not awaiting payment, and records nothing', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await book(app); // still draft
    const res = await markPaid(app, b.id, { method: 'cash' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'not_awaiting_payment', status: 'draft' });
    expect((await bookings.get(b.id))!.status).toBe('draft');
    expect(await payments.findByBookingId(b.id)).toHaveLength(0);
  });

  it('400 for an unknown method', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    const res = await markPaid(app, b.id, { method: 'crypto' });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'invalid_mark_paid_request' });
    expect((await bookings.get(b.id))!.status).toBe('payment_pending');
    expect(await payments.findByBookingId(b.id)).toHaveLength(0);
  });

  it('refuses a caller without payments:act (ops session, and the machine key)', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    expect((await markPaid(app, b.id, { method: 'cash' }, 'op@x.com')).status).toBe(403);
    const key = await app.request(`/admin/bookings/${b.id}/mark-paid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-admin-key': KEY },
      body: JSON.stringify({ method: 'cash' }),
    });
    expect(key.status).toBe(403);
    expect((await app.request(`/admin/bookings/${b.id}/mark-paid`, { method: 'POST' })).status).toBe(401);
    expect(await payments.findByBookingId(b.id)).toHaveLength(0);
  });

  it('404 for an unknown booking', async () => {
    const { app } = makeCashApp();
    expect((await markPaid(app, 'no-such', { method: 'cash' })).status).toBe(404);
  });

  it('is idempotent — a double-click never records the money twice', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    expect((await markPaid(app, b.id, { method: 'cash' })).status).toBe(200);
    const second = await markPaid(app, b.id, { method: 'cash' });
    expect(second.status).toBe(200);
    expect((await second.json()).status).toBe('paid');
    const rows = await payments.findByBookingId(b.id);
    expect(rows).toHaveLength(1);
    expect(rows.reduce((sum, p) => sum + p.amount, 0)).toBe(b.amountDueNow ?? b.total);
  });

  // The failure mode this route exists to prevent, reintroduced by a too-eager idempotency gate:
  // create() claims the key with a PENDING row, so if the settle step dies (a 23505 on the
  // provider/gateway-reference UNIQUE when ops enters one bank slip on two bookings, or any
  // transient connection error), every retry short-circuits on that pending row and answers 200
  // with an unchanged booking — no money recorded, no error, and no repair path. Only a
  // SUCCEEDED payment may short-circuit.
  it('a retry after a mid-flight failure finishes the job — a pending row must not short-circuit', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    // Exactly what a crashed first attempt leaves behind: the key claimed, the money not settled.
    const stranded = await payments.create({
      bookingId: b.id,
      provider: 'cash',
      orderId: `${b.reference}-MANUAL`,
      amount: b.amountDueNow ?? b.total,
      currency: b.currency,
      idempotencyKey: `manual-paid:${b.id}`,
    });
    expect(stranded.status).toBe('pending');

    const res = await markPaid(app, b.id, { method: 'cash', reference: 'BOC-77219' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    expect((await bookings.get(b.id))!.status).toBe('paid');
    const rows = await payments.findByBookingId(b.id);
    expect(rows).toHaveLength(1); // the retry reuses the claimed row, it does not take the money twice
    expect(rows[0].id).toBe(stranded.id);
    expect(rows[0].status).toBe('succeeded');
    expect(payments.getForSettlement(rows[0].id)!.settlementSource).toBe('manual');
  });

  // The other half of the same window: the money settled but the status write did not land (a
  // connection blip on setStatus). The payment is succeeded while the booking is still
  // payment_pending, and nothing else can move payment_pending → paid — no webhook is coming for
  // cash, and confirm/cancel/no-show do not start there. A retry must finish the status step
  // rather than answer 200 with the stranded booking, and must not take the money a second time.
  it('a retry after the status write failed finishes the transition — the money is not taken twice', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    // Exactly what a mark-paid whose setStatus threw leaves behind: money recorded, booking stuck.
    const settled = await payments.create({
      bookingId: b.id,
      provider: 'cash',
      orderId: `${b.reference}-MANUAL`,
      amount: b.amountDueNow ?? b.total,
      currency: b.currency,
      idempotencyKey: `manual-paid:${b.id}`,
    });
    await payments.markSucceededManually(settled.id, { reference: 'BOC-77219' });
    expect((await bookings.get(b.id))!.status).toBe('payment_pending');

    const res = await markPaid(app, b.id, { method: 'cash', reference: 'BOC-77219' });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('paid');
    expect((await bookings.get(b.id))!.status).toBe('paid');
    const rows = await payments.findByBookingId(b.id);
    expect(rows).toHaveLength(1); // our own succeeded row must not trip the already_paid ledger guard
    expect(rows[0].id).toBe(settled.id);
    expect(rows.reduce((sum, p) => sum + p.amount, 0)).toBe(b.amountDueNow ?? b.total);
  });

  // A PayHere webhook that settles late (delayed or retried) can land on a booking ops has
  // already decided to settle by hand. Two succeeded rows for one booking double the captured
  // total refundRepo sums, so refund_exceeds_captured would let us refund twice the money taken.
  it('409 already_paid when the ledger already holds a succeeded payment, and records nothing', async () => {
    const { app, bookings, payments } = makeCashApp();
    const b = await awaitingPayment(app, bookings);
    const gateway = await payments.create({
      bookingId: b.id,
      provider: 'payhere',
      orderId: b.reference,
      amount: b.amountDueNow ?? b.total,
      currency: b.currency,
      idempotencyKey: `checkout:${b.id}`,
    });
    await payments.markSucceeded(gateway.id);

    const res = await markPaid(app, b.id, { method: 'cash' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_paid', status: 'payment_pending' });
    expect(await payments.findByBookingId(b.id)).toHaveLength(1);
  });
});

describe('mark-paid claims the linked quote', () => {
  it('recording cash on a pay-link booking flips its quote to won', async () => {
    const quotes = new InMemoryQuoteRepo();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adminApiKey: KEY, auth, quotes, bookings });
    const q = await quotes.save({
      channel: 'ops', product: 'private', totalCents: 5000, currency: 'USD',
      rateCardVersion: 'v1', request: { engine: {} }, result: {},
    });
    await quotes.patch(q.id, { status: 'pending_review' });
    await quotes.patch(q.id, { status: 'ready' });
    await quotes.patch(q.id, { status: 'sent' });
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    await quotes.patch(q.id, { convertedBookingId: b.id });

    const res = await app.request(`/admin/bookings/${b.id}/mark-paid`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
      body: JSON.stringify({ method: 'bank_transfer', reference: 'slip-9' }),
    });
    expect(res.status).toBe(200);
    expect((await quotes.get(q.id))?.status).toBe('won');
  });
});

// ── Burst cap (notification safety rails, slice 1) ─────────────────────────
describe('POST /admin/jobs/notifications — burst cap', () => {
  async function seedDueReminders(bookings: InMemoryBookingRepo, n: number) {
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    for (let i = 0; i < n; i++) {
      const b = await bookings.create({
        mode: 'single',
        input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
        total: 5000, amountDueNow: 5000, currency: 'USD',
      });
      await bookings.setStatus(b.id, 'payment_pending');
      await bookings.setStatus(b.id, 'paid');
    }
  }

  it('stops at the cap, pages the founder, and reports what it held back', async () => {
    const bookings = new InMemoryBookingRepo();
    const email = new FakeEmailAdapter();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adminApiKey: KEY, auth, bookings, email, alerts, notifyMaxPerRun: 3 });
    await seedDueReminders(bookings, 9);

    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.reminders).toBe(3);
    expect(body.suppressed).toBe(6);
    expect(email.sent.filter((m) => /coming up/i.test(m.subject))).toHaveLength(3);

    const burst = alerts.sent.filter((a) => a.kind === 'notification_burst_suppressed');
    expect(burst).toHaveLength(1);
    expect(burst[0].severity).toBe('critical');
    expect(burst[0].body).toMatch(/trip_reminder: 6/);
  });

  it('raises no burst alert on a normal tick', async () => {
    const bookings = new InMemoryBookingRepo();
    const alerts = new FakeAlertAdapter();
    const app = createApp({ adminApiKey: KEY, auth, bookings, email: new FakeEmailAdapter(), alerts, notifyMaxPerRun: 25 });
    await seedDueReminders(bookings, 2);

    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect((await res.json()).suppressed).toBe(0);
    expect(alerts.sent.filter((a) => a.kind === 'notification_burst_suppressed')).toHaveLength(0);
  });
});

// ── Outbound mail guard (notification safety rails, slice 2) ───────────────
describe('EMAIL_ALLOWLIST is enforced end-to-end, not just in the adapter', () => {
  it('a real customer address is dropped before it reaches the provider', async () => {
    const bookings = new InMemoryBookingRepo();
    const email = new FakeEmailAdapter();
    // What staging will run: only ceylonhop.com addresses are reachable.
    const app = createApp({
      adminApiKey: KEY, auth, bookings, email,
      emailPolicy: { allowlist: ['@ceylonhop.com'] },
    });
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const b = await bookings.create({
      mode: 'single',
      input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
      total: 5000, amountDueNow: 5000, currency: 'USD',
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');

    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });

    // The sweep ran and considered the booking handled — but nothing left the building.
    // Suppression is deliberately invisible to the caller (see GuardedEmailAdapter): the
    // send is ledgered, so a later run will NOT retry it.
    expect((await res.json()).reminders).toBe(1);
    expect(email.sent).toHaveLength(0);
  });
});

// ── Dry run (notification safety rails, slice 5) ───────────────────────────
describe('POST /admin/jobs/notifications?dryRun=1', () => {
  it('reports the plan and mutates nothing — not the ledger, not the other sweeps', async () => {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const email = new FakeEmailAdapter();
    const app = createApp({ adminApiKey: KEY, auth, bookings, departures, email });

    // A reminder that a real tick would send…
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const due = await bookings.create({
      mode: 'single',
      input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
      total: 5000, amountDueNow: 5000, currency: 'USD',
    });
    await bookings.setStatus(due.id, 'payment_pending');
    await bookings.setStatus(due.id, 'paid');

    // …and a stale shared hold the same tick would normally cancel.
    await departures.holdSeats({ corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 12 });
    const hold = await bookings.create({
      mode: 'shared',
      input: { corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 12, customer: valid.customer },
      total: 25200, amountDueNow: 25200, currency: 'USD',
    });
    (await bookings.get(hold.id))!.createdAt = new Date(Date.now() - 25 * 3600 * 1000).toISOString();

    const res = await app.request('/admin/jobs/notifications?dryRun=1', { method: 'POST', headers: { 'x-admin-key': KEY } });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.dryRun).toBe(true);
    expect(body.plan).toEqual([{ reference: due.reference, kind: 'trip_reminder' }]);
    expect(email.sent).toHaveLength(0);
    // A dry run is READ-ONLY across the whole tick, not just the mail part.
    expect((await bookings.get(hold.id))!.status).toBe('draft');
  });

  it('the real tick still sends afterwards — a dry run consumes nothing', async () => {
    const bookings = new InMemoryBookingRepo();
    const email = new FakeEmailAdapter();
    const app = createApp({ adminApiKey: KEY, auth, bookings, email });
    const tomorrow = new Date(Date.now() + 24 * 3600 * 1000).toISOString().slice(0, 10);
    const b = await bookings.create({
      mode: 'single',
      input: { ...valid, vehicleType: 'car' as const, date: tomorrow, time: '09:00' },
      total: 5000, amountDueNow: 5000, currency: 'USD',
    });
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');

    await app.request('/admin/jobs/notifications?dryRun=1', { method: 'POST', headers: { 'x-admin-key': KEY } });
    const res = await app.request('/admin/jobs/notifications', { method: 'POST', headers: { 'x-admin-key': KEY } });

    expect((await res.json()).reminders).toBe(1);
    expect(email.sent).toHaveLength(1);
  });

  it('still requires admin:jobs', async () => {
    const { app } = makeApp();
    expect((await app.request('/admin/jobs/notifications?dryRun=1', { method: 'POST' })).status).toBe(401);
  });
});
