import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { issueSessionCookie } from '../lib/opsMiddleware';
import { Hono } from 'hono';

// Founder analytics endpoints (spec 2026-07-23): both are analytics:view-gated — founder-only.
// Harness mirrors ops.auth.test.ts (mint a session cookie without Google).

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

describe('/admin/ops/analytics', () => {
  let app: ReturnType<typeof createApp>;
  let quotes: InMemoryQuoteRepo;
  beforeEach(() => {
    quotes = new InMemoryQuoteRepo();
    app = createApp({ quotes, auth, adminApiKey: 'adminkey' });
  });

  const get = async (path: string, email?: string) =>
    app.request(path, email ? { headers: { cookie: await cookie(email) } } : undefined);

  it('401 without a session, 403 for ops and finance, 403 for x-admin-key (system)', async () => {
    for (const path of ['/admin/ops/analytics/funnel', '/admin/ops/analytics/demand']) {
      expect((await app.request(path)).status).toBe(401);
      expect((await get(path, 'op@x.com')).status).toBe(403);
      expect((await get(path, 'fin@x.com')).status).toBe(403);
      expect((await app.request(path, { headers: { 'x-admin-key': 'adminkey' } })).status).toBe(403);
    }
  });

  it('founder gets a funnel report with defaults applied', async () => {
    await quotes.save({
      product: 'private', totalCents: 10000, currency: 'USD', rateCardVersion: 'v1',
      request: { tool: {}, engine: { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 90 }] } },
      result: {},
    });
    const res = await get('/admin/ops/analytics/funnel', 'founder@x.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tiles.created.value).toBe(1);
    expect(body.tiles.pipeline).toBeDefined();
    expect(body.aging.length).toBe(4);
    expect(body.series.length).toBeGreaterThan(0);
    expect(body.range.bucket).toBe('day');
    expect(body.truncated).toBe(false);
  });

  it('founder gets a demand report with coverage', async () => {
    await quotes.save({
      product: 'private', totalCents: 10000, currency: 'USD', rateCardVersion: 'v1', requestedService: 'private',
      request: { tool: {}, engine: { product: 'private', vehicle: 'car', pax: 2, bags: 0, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 90 }] } },
      result: {},
    });
    const res = await get('/admin/ops/analytics/demand', 'founder@x.com');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.coverage).toEqual({ parsed: 1, total: 1 });
    // Equal touch counts tiebreak alphabetically (deterministic ordering).
    expect(body.topDestinations.map((d: { place: string }) => d.place)).toEqual(['Ella', 'Kandy']);
    expect(body.truncated).toBe(false);
  });

  it('rejects an inverted range with 400', async () => {
    const res = await get('/admin/ops/analytics/funnel?from=2026-07-10&to=2026-07-01', 'founder@x.com');
    expect(res.status).toBe(400);
  });

  it('rejects a malformed bucket/channel with 400', async () => {
    expect((await get('/admin/ops/analytics/funnel?bucket=hour', 'founder@x.com')).status).toBe(400);
    expect((await get('/admin/ops/analytics/demand?channel=nope', 'founder@x.com')).status).toBe(400);
  });
});
