import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { ALL_OPS_ACTIONS, can } from '../lib/opsAuth';
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

  // Drift guard. whoami's caps list is a STRING CONTRACT with the ops client: ops-ui.html gates
  // the refund confirm/cancel actions on caps.includes('payments:reverse'), so a capability the
  // matrix grants but whoami forgets to list is a silently dead button, not a visible error.
  // That is exactly what happened: ALL_ACTIONS was hand-maintained and omitted payments:reverse,
  // which disabled refund confirmation for the founder — the only role that has it.
  //
  // These assertions are EXACT (not arrayContaining) on purpose: an omission is the failure mode,
  // and arrayContaining cannot see one. The list itself is now derived from the matrix, so this
  // test guards the derivation rather than a second hand-written copy of it.
  it('whoami lists every capability the matrix grants the role — exactly, in every role', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    for (const [email, role] of [['f@x.com', 'founder'], ['fin@x.com', 'finance'], ['op@x.com', 'ops']] as const) {
      const res = await app.request('/admin/ops/whoami', { headers: { cookie: await cookie(email) } });
      const body = await res.json();
      expect(body.role).toBe(role);
      const granted = ALL_OPS_ACTIONS.filter((a) => can(role, a));
      expect([...body.caps].sort()).toEqual([...granted].sort());
    }
  });

  // The specific regression: reversing a sale is founder-only, and the founder must be TOLD they
  // hold it or the client hides the action from the one person allowed to take it.
  it('whoami gives the founder payments:reverse, and nobody else', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const capsFor = async (email: string) =>
      (await (await app.request('/admin/ops/whoami', { headers: { cookie: await cookie(email) } })).json()).caps;
    expect(await capsFor('f@x.com')).toContain('payments:reverse');
    expect(await capsFor('fin@x.com')).not.toContain('payments:reverse');
    expect(await capsFor('op@x.com')).not.toContain('payments:reverse');
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
