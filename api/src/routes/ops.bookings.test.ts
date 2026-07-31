import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
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
