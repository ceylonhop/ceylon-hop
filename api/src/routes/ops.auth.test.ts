import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryRideOpsRepo } from '../db/rideOpsRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };

// Mint a session cookie for an email without invoking Google (mirrors opsMiddleware.test.ts's pattern).
async function cookie(email: string, secret = 'sek') {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, secret, Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}
function makeApp() {
  const bookings = new InMemoryBookingRepo();
  const app = createApp({ bookings, rideOps: new InMemoryRideOpsRepo(), auth, adminApiKey: 'adminkey' });
  return app;
}

describe('ops authorization surface', () => {
  let app: ReturnType<typeof createApp>;
  beforeEach(() => { app = makeApp(); });

  it('rejects reads without auth (401)', async () => {
    expect((await app.request('/admin/ops/bookings')).status).toBe(401);
    expect((await app.request('/admin/ops/whoami')).status).toBe(401);
  });
  it('rejects a forged cookie', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: 'ch_ops=deadbeef.deadbeef' } });
    expect(res.status).toBe(401);
  });
  it('rejects a cookie signed with the wrong secret', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: await cookie('op@x.com', 'other-secret') } });
    expect(res.status).toBe(401);
  });
  it('accepts a valid ops session (200)', async () => {
    const res = await app.request('/admin/ops/bookings', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
  });
  it('x-admin-key satisfies admin:jobs elsewhere but is NOT a founder backdoor here', async () => {
    // system only has admin:jobs; /admin/ops/bookings needs bookings:read, which system lacks.
    const res = await app.request('/admin/ops/bookings', { headers: { 'x-admin-key': 'adminkey' } });
    expect(res.status).toBe(403);
  });
});
