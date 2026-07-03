import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' };

describe('daily rides', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let rideOps: InMemoryRideOpsRepo;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo(); rideOps = new InMemoryRideOpsRepo();
    app = createApp({ bookings, rideOps, coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });
    await bookings.create({
      mode: 'single', total: 9000, amountDueNow: 9000, currency: 'USD',
      input: { from: 'Galle', to: 'Mirissa', vehicleType: 'car', adults: 2, children: 0, bags: 0,
        date: '2026-06-25', time: '08:00',
        customer: { firstName: 'Sam', lastName: 'P', email: 's@x.com', whatsapp: '+1', country: 'US' } },
    });
  });

  it('returns rides for a given travel date', async () => {
    const res = await app.request('/admin/ops/rides?date=2026-06-25', { headers: hdr });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].route).toBe('Galle → Mirissa');
  });
});
