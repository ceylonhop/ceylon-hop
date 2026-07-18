import { describe, it, expect, vi } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryDepartureRepo } from '../db/departureRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { issueSessionCookie } from '../lib/opsMiddleware';
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
  it('cancels the booking for a founder/finance session, transitions it to cancelled, and emails the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('cancelled');
    expect((await bookings.get(b.id))!.status).toBe('cancelled');
    const sent = email.sent.filter((m) => /cancel/i.test(m.subject));
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('maya@example.com');
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

  it('403 for an ops session (no payments:act)', async () => {
    const { app } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST', headers: { cookie: await cookie('op@x.com') },
    });
    expect(res.status).toBe(403);
  });

  it('404 for an unknown booking', async () => {
    const { app } = makeApp();
    const res = await app.request('/admin/bookings/no-such/cancel', {
      method: 'POST', headers: { cookie: await cookie('f@x.com') },
    });
    expect(res.status).toBe(404);
  });

  it('409 when the booking cannot be cancelled (already cancelled)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'cancelled');
    const res = await app.request(`/admin/bookings/${b.id}/cancel`, {
      method: 'POST', headers: { cookie: await cookie('f@x.com') },
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
      method: 'POST', headers: { cookie: await cookie('f@x.com') },
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
      // stamp sentAt 31 days ago — past the 30-day idle TTL
      vi.setSystemTime(new Date(NOW.getTime() - 31 * 24 * 3600 * 1000));
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
    date: '2026-07-22', // Wednesday — a shared service day (corridors run Wed & Sat)
    time: '08:00',
    seats: 12, // the whole bus, so a leaked hold is observable as a sold-out 409
    customer: valid.customer,
  };

  function makeSharedApp() {
    const bookings = new InMemoryBookingRepo();
    const departures = new InMemoryDepartureRepo();
    const app = createApp({ adminApiKey: KEY, auth, bookings, departures, email: new FakeEmailAdapter() });
    return { app, bookings, departures };
  }

  function bookShared(app: ReturnType<typeof createApp>) {
    return app.request('/bookings/shared', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(shared),
    });
  }

  it('cancel releases the seats — the departure can be booked again', async () => {
    const { app } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    expect((await bookShared(app)).status).toBe(409); // full while held
    await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { cookie: await cookie('f@x.com') } });
    expect((await bookShared(app)).status).toBe(201); // freed by the cancel
  });

  it('refund of a paid shared booking releases the seats', async () => {
    const { app, bookings } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    await app.request(`/admin/bookings/${b.id}/refund`, { method: 'POST', headers: { cookie: await cookie('f@x.com') } });
    expect((await bookShared(app)).status).toBe(201);
  });

  it('refund after cancel does not release the seats twice', async () => {
    const { app, bookings, departures } = makeSharedApp();
    const b = await (await bookShared(app)).json();
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    // another traveller takes 3 of the freed seats between the cancel and the refund
    await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { cookie: await cookie('f@x.com') } });
    const other = await departures.holdSeats({ corridorId: 'hill-line', date: shared.date, time: shared.time, seats: 3 });
    expect(other?.seatsBooked).toBe(3);
    await app.request(`/admin/bookings/${b.id}/refund`, { method: 'POST', headers: { cookie: await cookie('f@x.com') } });
    // the other traveller's hold must survive — no second release
    const after = await departures.holdSeats({ corridorId: 'hill-line', date: shared.date, time: shared.time, seats: 1 });
    expect(after?.seatsBooked).toBe(4);
  });

  it('cancelling a non-shared booking never touches departures', async () => {
    const { app, departures } = makeSharedApp();
    const b = await book(app); // a single transfer
    const spy = vi.spyOn(departures, 'releaseSeats');
    await app.request(`/admin/bookings/${b.id}/cancel`, { method: 'POST', headers: { cookie: await cookie('f@x.com') } });
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('POST /admin/bookings/:id/refund', () => {
  it('refunds a paid booking for a founder/finance session, transitions it to refunded, and emails the customer', async () => {
    const { app, bookings, email } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/refund`, {
      method: 'POST', headers: { cookie: await cookie('fin@x.com') },
    });
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe('refunded');
    expect((await bookings.get(b.id))!.status).toBe('refunded');
    expect(email.sent.filter((m) => /refund/i.test(m.subject))).toHaveLength(1);
  });

  it('409 when the booking cannot be refunded (still a draft)', async () => {
    const { app } = makeApp();
    const b = await book(app);
    const res = await app.request(`/admin/bookings/${b.id}/refund`, {
      method: 'POST', headers: { cookie: await cookie('f@x.com') },
    });
    expect(res.status).toBe(409);
  });

  it('403 for the system key — the machine key can no longer issue refunds (D6)', async () => {
    const { app, bookings } = makeApp();
    const b = await book(app);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/bookings/${b.id}/refund`, { method: 'POST', headers: { 'x-admin-key': KEY } });
    expect(res.status).toBe(403);
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
      method: 'POST', headers: { cookie: await cookie('f@x.com') },
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
