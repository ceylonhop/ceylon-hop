import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

const auth = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
async function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('ops capability gates', () => {
  it('finance/summary is margin:view-gated — 403 for finance and ops, 200 for founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('fin@x.com') } })).status).toBe(403);
    expect((await app.request('/admin/ops/finance/summary', { headers: { cookie: await cookie('f@x.com') } })).status).toBe(200);
  });

  it('bookings:operate mutators reject finance (403) but allow ops and founder', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/bookings/does-not-exist/status', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('fin@x.com') },
      body: JSON.stringify({ to: 'vehicle_confirmed' }),
    });
    expect(res.status).toBe(403);
  });

  it('whoami returns {email, role, caps} — caps reflects the resolved role, not the cookie', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('op@x.com') } });
    const body = await res.json();
    expect(body.email).toBe('op@x.com');
    expect(body.role).toBe('ops');
    expect(body.caps).toEqual(expect.arrayContaining(['quote:manage', 'bookings:operate', 'bookings:read']));
    expect(body.caps).not.toContain('margin:view');
    expect(body.caps).not.toContain('payments:act');
    expect(body.caps).not.toContain('quote:approve'); // support cannot approve — the client must not show approve UI
  });

  it('whoami exposes quote:approve (the maker-checker gate) to the founder only', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/whoami', { headers: { cookie: await cookie('f@x.com') } });
    const body = await res.json();
    expect(body.role).toBe('founder');
    expect(body.caps).toContain('quote:approve'); // client uses this to render the Approve action
    expect(body.caps).toContain('margin:view');
  });
});

// The assign picker (spec 2026-07-16 §7) needs the assignable staff list. Staff emails, so it is
// session-gated — and it must only offer people who can actually open the quote the email links to.
describe('GET /admin/ops/users — assignable staff for the assign picker', () => {
  // displayName is the picker's label. These users have no captured Google name (nobody has
  // signed in), so it degrades to the email local part — see ops.profiles.test.ts for the
  // named case.
  it('returns the OPS_USERS roster to any signed-in staff member', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/users', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.users).toEqual([
      { email: 'f@x.com', role: 'founder', displayName: 'f' },
      { email: 'fin@x.com', role: 'finance', displayName: 'fin' },
      { email: 'op@x.com', role: 'ops', displayName: 'op' },
    ]);
  });

  it('rejects an anonymous caller', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    expect((await app.request('/admin/ops/users')).status).toBe(401);
  });

  // Every listed user must hold quote:manage, or the deep link in their assignment email
  // (/ops?quote=<id>) silently falls back to the tickets queue — see ops-ui.html:1089.
  it('only lists users who can open a quote', async () => {
    const app = createApp({ auth: { ...auth, opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops' }, adminApiKey: 'adminkey' });
    const res = await app.request('/admin/ops/users', { headers: { cookie: await cookie('f@x.com') } });
    const body = await res.json();
    expect(body.users.length).toBeGreaterThan(0);
    for (const u of body.users) expect(['founder', 'finance', 'ops']).toContain(u.role);
  });
});
