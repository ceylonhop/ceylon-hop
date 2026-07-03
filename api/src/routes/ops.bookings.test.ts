import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' }; // founder via header

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
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey' });
    bid = (await seed(bookings)).id;
    await bookings.setStatus(bid, 'payment_pending');
  });

  it('lists bookings as ops rows', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: hdr });
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('Colombo Airport → Galle');
    expect(rows[0].stage).toBe('awaiting_payment'); // freshly created booking is draft/payment_pending
  });

  it('advances fulfilment status via the status endpoint', async () => {
    await bookings.setStatus(bid, 'paid');
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    const ops = await res.json();
    expect(ops.fulfilmentStatus).toBe('vehicle_confirmed');
  });

  it('rejects an illegal status transition with 400', async () => {
    await bookings.setStatus(bid, 'paid');
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'completed' }),
    });
    expect(res.status).toBe(400);
  });

  it('toggles flags', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/flags`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ vehiclePhotoReceived: true }),
    });
    expect((await res.json()).vehiclePhotoReceived).toBe(true);
  });

  it('lists payment_pending and paid bookings as the ops queue, ordered by travel date', async () => {
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
    await bookings.setStatus(completed.id, 'completed'); // excluded (booking-level)

    const res = await app.request('/admin/ops/bookings', { headers: hdr });
    const rows = await res.json();
    // Queue = bid (payment_pending, travelDate 2026-06-22, from beforeEach) + paid + pending.
    // draft and completed are excluded. Sorted by travelDate ascending.
    expect(rows).toHaveLength(3);
    expect(rows[0].id).toBe(bid);
    expect(rows[0].travelDate).toBe('2026-06-22');
    expect(rows[0].stage).toBe('awaiting_payment');
    expect(rows[1].travelDate).toBe('2026-07-05');
    expect(rows[1].stage).toBe('awaiting_payment');
    expect(rows[2].travelDate).toBe('2026-07-10');
    expect(rows[2].stage).toBe('paid');
    expect(rows[0].channel).toBe('website');
  });

  it('reflects ride_ops fulfilment as stage for paid bookings', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const rideOps = new InMemoryRideOpsRepo();
    const app2 = createApp({ bookings, rideOps, auth, adminApiKey: 'adminkey' });
    await rideOps.getOrCreate(b.id);
    await rideOps.setStatus(b.id, 'vehicle_confirmed');
    const res = await app2.request('/admin/ops/bookings', { headers: hdr });
    const rows = await res.json();
    expect(rows.find((r: { id: string }) => r.id === b.id).stage).toBe('vehicle_confirmed');
  });

  it('advances stage via POST /bookings/:id/status with the new machine', async () => {
    const b = await seed(bookings);
    await bookings.setStatus(b.id, 'payment_pending');
    await bookings.setStatus(b.id, 'paid');
    const res = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(res.status).toBe(200);
    const bad = await app.request(`/admin/ops/bookings/${b.id}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'completed' }),
    });
    expect(bad.status).toBe(400);
  });

  it('has no coordinator, manifest, or rides routes', async () => {
    for (const path of ['/admin/ops/coordinators', '/admin/ops/manifest', '/admin/ops/rides']) {
      const res = await app.request(path, { headers: hdr });
      expect(res.status).toBe(404);
    }
  });
});
