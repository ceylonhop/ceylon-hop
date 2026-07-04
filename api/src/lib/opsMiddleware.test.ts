import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { opsIdentity, requireCap, issueSessionCookie, type OpsAuthConfig } from './opsMiddleware';

const cfg: OpsAuthConfig = {
  opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops',
  googleClientId: 'cid', sessionSecret: 'sek', adminApiKey: 'adminkey', nodeEnv: 'test',
};

function appWith(action: Parameters<typeof requireCap>[0]) {
  const app = new Hono();
  app.use('*', opsIdentity(cfg));
  app.get('/probe', requireCap(action), (c) => c.json({ role: c.get('identity').role }));
  // helper to mint a cookie for a chosen email
  app.post('/mint', async (c) => {
    const { email } = await c.req.json();
    issueSessionCookie(c, email, cfg.sessionSecret, Date.now());
    return c.json({ ok: true });
  });
  return app;
}

async function cookieFor(app: Hono, email: string) {
  const res = await app.request('/mint', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('opsIdentity + requireCap', () => {
  it('401 when no cookie and no key', async () => {
    const app = appWith('bookings:read');
    expect((await app.request('/probe')).status).toBe(401);
  });

  it('allows founder through payments:act', async () => {
    const app = appWith('payments:act');
    const cookie = await cookieFor(app, 'f@x.com');
    expect((await app.request('/probe', { headers: { cookie } })).status).toBe(200);
  });

  it('403 for ops on payments:act (capability denied)', async () => {
    const app = appWith('payments:act');
    const cookie = await cookieFor(app, 'op@x.com');
    expect((await app.request('/probe', { headers: { cookie } })).status).toBe(403);
  });

  it('revokes instantly: a valid cookie whose email left OPS_USERS → 403', async () => {
    const app = appWith('bookings:read');
    const cookie = await cookieFor(app, 'f@x.com');
    // rebuild the app with the founder removed from the allowlist, same secret
    const app2 = new Hono();
    app2.use('*', opsIdentity({ ...cfg, opsUsers: 'fin@x.com:finance' }));
    app2.get('/probe', requireCap('bookings:read'), (c) => c.json({ ok: true }));
    expect((await app2.request('/probe', { headers: { cookie } })).status).toBe(403);
  });

  it('x-admin-key → system satisfies admin:jobs but not payments:act', async () => {
    const jobs = appWith('admin:jobs');
    const pay = appWith('payments:act');
    expect((await jobs.request('/probe', { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(200);
    expect((await pay.request('/probe', { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(403);
  });
});
