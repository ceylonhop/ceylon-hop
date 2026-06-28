import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { InMemoryCoordinatorRepo } from '../db/coordinatorRepo';

const auth = { opsSupportKey: 'sup', opsFounderKey: 'fou', opsSessionSecret: 'sek' };

function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const app = createApp({
    bookings,
    rideOps: new InMemoryRideOpsRepo(),
    coordinators: new InMemoryCoordinatorRepo(),
    auth,
    adminApiKey: 'adminkey',
  });
  return { app, bookings };
}

async function seed(bookings: InMemoryBookingRepo) {
  return bookings.create({
    mode: 'single', total: 12100, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      date: '2026-06-22', time: '09:00',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
  });
}

describe('ops authorization surface', () => {
  let app: ReturnType<typeof createApp>;
  let bid: string;
  beforeEach(async () => {
    const m = makeApp();
    app = m.app;
    bid = (await seed(m.bookings)).id;
  });

  it('rejects EVERY ops endpoint without auth (401) — reads and mutators', async () => {
    const calls: [string, string, unknown][] = [
      ['GET', '/admin/ops/bookings', null],
      ['GET', `/admin/ops/bookings/${bid}`, null],
      ['POST', `/admin/ops/bookings/${bid}/assign`, { coordinatorId: 'c1' }],
      ['POST', `/admin/ops/bookings/${bid}/status`, { to: 'assigned' }],
      ['POST', `/admin/ops/bookings/${bid}/flags`, { vehiclePhotoReceived: true }],
      ['GET', '/admin/ops/coordinators', null],
      ['POST', '/admin/ops/coordinators', { name: 'X', whatsapp: '+1' }],
      ['GET', '/admin/ops/finance/summary', null],
    ];
    for (const [method, path, body] of calls) {
      const res = await app.request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body ? JSON.stringify(body) : undefined,
      });
      expect(res.status, `${method} ${path} should be 401 without auth`).toBe(401);
    }
  });

  it('rejects a forged session cookie (HMAC must verify, not just parse)', async () => {
    const res = await app.request('/admin/ops/bookings', {
      headers: { cookie: 'ch_ops=founder.deadbeefdeadbeefdeadbeef' },
    });
    expect(res.status).toBe(401);
  });

  it('rejects a session cookie signed with the wrong secret', async () => {
    // a real login on a DIFFERENT app (different secret) must not be honoured here
    const other = createApp({ ...{ bookings: new InMemoryBookingRepo() }, rideOps: new InMemoryRideOpsRepo(), coordinators: new InMemoryCoordinatorRepo(), auth: { ...auth, opsSessionSecret: 'a-different-secret' }, adminApiKey: 'adminkey' });
    const login = await other.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sup' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/admin/ops/bookings', { headers: { cookie } });
    expect(res.status).toBe(401);
  });

  it('positive control: a validly signed session is accepted (200)', async () => {
    const login = await app.request('/admin/ops/login', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ key: 'sup' }),
    });
    const cookie = login.headers.get('set-cookie')!.split(';')[0];
    const res = await app.request('/admin/ops/bookings', { headers: { cookie } });
    expect(res.status).toBe(200);
  });
});
