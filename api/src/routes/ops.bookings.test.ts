import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' }; // founder via header

async function seed(bookings: InMemoryBookingRepo) {
  return bookings.create({
    mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      date: '2026-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  });
}

describe('ops bookings endpoints', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let bid: string;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo();
    app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });
    bid = (await seed(bookings)).id;
  });

  it('lists bookings as ops rows', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: hdr });
    const rows = await res.json();
    expect(rows).toHaveLength(1);
    expect(rows[0].route).toBe('Colombo Airport → Galle');
    expect(rows[0].fulfilmentStatus).toBe('paid');
  });

  it('advances fulfilment status via the status endpoint', async () => {
    const res = await app.request(`/admin/ops/bookings/${bid}/status`, {
      method: 'POST', headers: hdr, body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    const ops = await res.json();
    expect(ops.fulfilmentStatus).toBe('vehicle_confirmed');
  });

  it('rejects an illegal status transition with 400', async () => {
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
});
