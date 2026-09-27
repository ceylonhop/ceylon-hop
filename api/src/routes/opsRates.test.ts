import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { ratesFromCard, PREVIEW_SAMPLES } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';
import { signSession } from '../lib/opsAuth';

// Founder rates API (spec 2026-09-26 §7, §8.4): read under margin:view, save and preview under
// rates:manage, append-only, stale-safe.
const AUTH = { opsUsers: 'f@x.com:founder,op@x.com:ops,fin@x.com:finance', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const OPS = cookie('op@x.com');
const FINANCE = cookie('fin@x.com');
const RATES = ratesFromCard(RATE_CARD);

function setup(deps: AppDeps = {}) {
  const rateRevisions = new InMemoryRateRevisionRepo();
  const a = createApp({ auth: AUTH, adminApiKey: 'k', allowedOrigins: ['https://ops.example'], rateRevisions, ...deps });
  const get = (ck = FOUNDER) => a.request('/admin/rates', { headers: { cookie: ck } });
  const post = (path: string, body: unknown, ck = FOUNDER, headers: Record<string, string> = {}) =>
    a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: ck, ...headers }, body: JSON.stringify(body) });
  return { a, rateRevisions, get, post };
}

describe('GET /admin/rates', () => {
  it('shows the code defaults as live before anything is saved', async () => {
    const s = setup();
    const res = await s.get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.live).toEqual({ version: RATE_CARD.version, source: 'defaults', rates: RATES, createdBy: null, createdAt: null });
    expect(body.defaults).toEqual({ version: RATE_CARD.version, rates: RATES });
    expect(body.history).toEqual([]);
    expect(body.readOnly).toEqual({ depositPct: RATE_CARD.deposit.pct, depositCapCents: RATE_CARD.deposit.capCents });
  });

  it('is founder-only: ops and finance get 403, no session gets 401', async () => {
    const s = setup();
    expect((await s.get(OPS)).status).toBe(403);
    expect((await s.get(FINANCE)).status).toBe(403);
    expect((await s.a.request('/admin/rates')).status).toBe(401);
  });
});

describe('POST /admin/rates', () => {
  it('saves a revision stamped with the founder, which GET then shows as live and in history', async () => {
    const s = setup();
    const res = await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } });
    expect(res.status).toBe(201);
    const { revision } = await res.json();
    expect(revision).toMatchObject({ seq: 1, createdBy: 'f@x.com', revertedToVersion: null, rates: { bufferPct: 12 } });
    expect(typeof revision.createdAt).toBe('string');
    const body = await (await s.get()).json();
    expect(body.live).toMatchObject({ version: revision.version, source: 'revision', createdBy: 'f@x.com' });
    expect(body.history.map((h: { version: string }) => h.version)).toEqual([revision.version]);
  });

  it('rejects out-of-range or over-precise values with 400, and saves nothing', async () => {
    const s = setup();
    for (const rates of [
      { ...RATES, perKmCents: { ...RATES.perKmCents, car: 40.255 } },
      { ...RATES, bufferPct: 99 },
      { ...RATES, depositPct: 20 },
    ]) {
      const res = await s.post('/admin/rates', { baseVersion: null, rates });
      expect(res.status).toBe(400);
    }
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('refuses a save from a stale version with 409 and names the current revision', async () => {
    const s = setup();
    const first = (await (await s.post('/admin/rates', { baseVersion: null, rates: RATES })).json()).revision;
    const res = await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } });
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toMatchObject({ error: 'stale_rates', current: { version: first.version, createdBy: 'f@x.com' } });
  });

  it('ops and finance cannot save', async () => {
    const s = setup();
    expect((await s.post('/admin/rates', { baseVersion: null, rates: RATES }, OPS)).status).toBe(403);
    expect((await s.post('/admin/rates', { baseVersion: null, rates: RATES }, FINANCE)).status).toBe(403);
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('a revert records what it restored, and must name a real version', async () => {
    const s = setup();
    const first = (await (await s.post('/admin/rates', { baseVersion: null, rates: { ...RATES, bufferPct: 12 } })).json()).revision;
    const bad = await s.post('/admin/rates', { baseVersion: first.version, rates: RATES, revertedToVersion: '1999-01-01.9' });
    expect(bad.status).toBe(400);
    const res = await s.post('/admin/rates', { baseVersion: first.version, rates: RATES, revertedToVersion: RATE_CARD.version });
    expect(res.status).toBe(201);
    expect((await res.json()).revision).toMatchObject({ seq: 2, revertedToVersion: RATE_CARD.version });
  });

  it('refuses a cross-site post (CSRF), like every other admin write', async () => {
    const s = setup();
    const res = await s.post('/admin/rates', { baseVersion: null, rates: RATES }, FOUNDER, { 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect(await s.rateRevisions.list()).toEqual([]);
  });
});

describe('POST /admin/rates/preview', () => {
  it('prices the four sample trips at the current and proposed rates, and saves nothing', async () => {
    const s = setup();
    const res = await s.post('/admin/rates/preview', { rates: { ...RATES, perKmCents: { ...RATES.perKmCents, car: 60 } } });
    expect(res.status).toBe(200);
    const { samples } = await res.json();
    expect(samples.map((x: { label: string }) => x.label)).toEqual(PREVIEW_SAMPLES.map((p) => p.label));
    const car150 = samples.find((x: { label: string }) => x.label === '150 km car transfer');
    expect(car150.proposedCents).toBeGreaterThan(car150.currentCents);
    expect(await s.rateRevisions.list()).toEqual([]);
  });

  it('is founder-only', async () => {
    const s = setup();
    expect((await s.post('/admin/rates/preview', { rates: RATES }, OPS)).status).toBe(403);
  });
});
