import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { InMemoryAlertLogRepo } from '../db/alertLogRepo';
import { InMemoryUsageCounterRepo } from '../db/usageCounterRepo';
import { UsageMeter } from '../services/usageMeter';

// GET /admin/ops/health (spec 2026-10-13 §5): founder-only, gated on analytics:view like the
// Analytics page — the matrix row would be identical, and "founder-only system page" is what that
// capability already means. Harness mirrors opsAnalytics.test.ts.

const auth = {
  opsUsers: 'founder@x.com:founder,fin@x.com:finance,op@x.com:ops',
  googleClientId: 'cid',
  opsSessionSecret: 'sek',
};

async function cookie(email: string) {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, email, 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

describe('/admin/ops/health', () => {
  const path = '/admin/ops/health';

  it('401 without a session, 403 for ops, finance and the x-admin-key system identity', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    expect((await app.request(path)).status).toBe(401);
    expect((await app.request(path, { headers: { cookie: await cookie('op@x.com') } })).status).toBe(403);
    expect((await app.request(path, { headers: { cookie: await cookie('fin@x.com') } })).status).toBe(403);
    expect((await app.request(path, { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(403);
  });

  it('founder gets the health payload, with the meter flushed first', async () => {
    const usageCounters = new InMemoryUsageCounterRepo();
    const usageMeter = new UsageMeter(usageCounters, { flushMs: 0 });
    usageMeter.bump('email.sent', 2);
    const app = createApp({
      auth, adminApiKey: 'adminkey',
      alertLog: new InMemoryAlertLogRepo(),
      usageCounters, usageMeter,
      dbSize: async () => 1234,
      emailDailyLimit: 100, emailMonthlyLimit: 3000,
    });
    const res = await app.request(path, { headers: { cookie: await cookie('founder@x.com') } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.dayBasis).toBe('utc');
    expect(body.email.today.sent).toBe(2);
    expect(body.email.dailyLimit).toBe(100);
    expect(body.db.sizeBytes).toBe(1234);
    expect(body.jobs.watchdog).toEqual({ lastRunAt: null, stale: true });
    expect(Array.isArray(body.links)).toBe(true);
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('still answers without counters wired (keyless dev)', async () => {
    const app = createApp({ auth, adminApiKey: 'adminkey' });
    const res = await app.request(path, { headers: { cookie: await cookie('founder@x.com') } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.email.today).toEqual({ sent: 0, failed: 0, suppressed: 0 });
    expect(body.db).toEqual({ sizeBytes: null });
  });
});
