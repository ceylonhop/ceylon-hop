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

  // D5 revocation (spec §6/§7): role is re-resolved from OPS_USERS on every request, never
  // cached in the cookie. A still-valid, correctly-signed cookie for an email that has since
  // been removed from the allowlist must be rejected — not honored until natural expiry.
  it('D5 revocation: a valid cookie for an email removed from OPS_USERS is rejected (403), not honored', async () => {
    // Same session secret, but this app's allowlist no longer contains the email —
    // simulates the email being removed from OPS_USERS between cookie issuance and use.
    const revokedAuth = { opsUsers: 'someone-else@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
    const revokedApp = createApp({
      bookings: new InMemoryBookingRepo(),
      rideOps: new InMemoryRideOpsRepo(),
      auth: revokedAuth,
      adminApiKey: 'adminkey',
    });
    const staleCookie = await cookie('op@x.com'); // valid signature, was allowlisted at mint time
    const res = await revokedApp.request('/admin/ops/bookings', { headers: { cookie: staleCookie } });
    expect(res.status).toBe(403);
  });
});
