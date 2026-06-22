import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };
const hdr = { 'x-admin-key': 'adminkey', 'content-type': 'application/json' };

describe('daily rides, coordinators, manifest', () => {
  let app: ReturnType<typeof createApp>; let bookings: InMemoryBookingRepo; let rideOps: InMemoryRideOpsRepo; let bid: string;
  beforeEach(async () => {
    bookings = new InMemoryBookingRepo(); rideOps = new InMemoryRideOpsRepo();
    app = createApp({ bookings, rideOps, coordinators: new InMemoryCoordinatorRepo(), auth, adminApiKey: 'adminkey' });
    bid = (await bookings.create({
      mode: 'single', total: 9000, currency: 'USD',
      input: { from: 'Galle', to: 'Mirissa', vehicleType: 'car', adults: 2, children: 0, bags: 0,
        date: '2026-06-25', time: '08:00',
        customer: { firstName: 'Sam', lastName: 'P', email: 's@x.com', whatsapp: '+1', country: 'US' } },
    })).id;
  });

  it('returns rides for a given travel date', async () => {
    const res = await app.request('/admin/ops/rides?date=2026-06-25', { headers: hdr });
    const body = await res.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0].route).toBe('Galle → Mirissa');
  });

  it('creates a coordinator and generates a manifest for assigned rides', async () => {
    const coord = await (await app.request('/admin/ops/coordinators', {
      method: 'POST', headers: hdr, body: JSON.stringify({ name: 'Nuwan', whatsapp: '+94770' }),
    })).json();
    await app.request(`/admin/ops/bookings/${bid}/assign`, { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id }) });
    const man = await (await app.request(`/admin/ops/manifest?coordinatorId=${coord.id}&date=2026-06-25`, { headers: hdr })).json();
    expect(man.text).toContain('Galle → Mirissa');
    expect(man.text).toContain('CH-');
    expect(man.text).not.toMatch(/\$|9000|USD/);
  });

  it('mark-sent advances assigned rides to sent_to_coordinator', async () => {
    const coord = await (await app.request('/admin/ops/coordinators', {
      method: 'POST', headers: hdr, body: JSON.stringify({ name: 'N', whatsapp: '+9' }),
    })).json();
    await app.request(`/admin/ops/bookings/${bid}/assign`, { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id }) });
    await app.request('/admin/ops/manifest/sent', { method: 'POST', headers: hdr, body: JSON.stringify({ coordinatorId: coord.id, date: '2026-06-25' }) });
    expect((await rideOps.get(bid))?.fulfilmentStatus).toBe('sent_to_coordinator');
  });
});
