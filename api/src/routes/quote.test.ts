import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { quoteRoutes } from './quote';
import { InMemoryQuoteRepo } from '../db/quoteRepo';


function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function postLock(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/quote/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const PRIVATE_LEG = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

describe('POST /quote/lock', () => {
  it('persists a channel=web quote with a 7-day rate lock and returns a bookable quote id', async () => {
    const quotes = new InMemoryQuoteRepo();
    const res = await postLock(createApp({ quotes }), PRIVATE_LEG);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.quoteId).toBeTruthy();
    expect(body.reference).toMatch(/^Q-/);
    expect(body.totalCents).toBe(3550); // raw 3542¢ → nearest-50¢ final price
    expect(body.marginEstimateCents).toBeUndefined(); // never leak margin to the customer
    // ~7 days out (allow a little slack for test execution time).
    expect(new Date(body.rateLockedUntil).getTime() - Date.now()).toBeGreaterThan(WEEK_MS - 60_000);

    const saved = await quotes.get(body.quoteId);
    expect(saved?.channel).toBe('web');
    expect(saved?.rateCardJson).toBeTruthy(); // the full card is snapshotted
    expect(saved?.rateLockedUntil).toBeInstanceOf(Date);
  });

  it('keeps customer web quotes out of the ops review queue (channel filter)', async () => {
    const quotes = new InMemoryQuoteRepo();
    await postLock(createApp({ quotes }), PRIVATE_LEG);
    expect(await quotes.list({ channel: 'ops' })).toHaveLength(0); // ops queue never shows web quotes
    expect(await quotes.list({ channel: 'web' })).toHaveLength(1);
  });

  it('501 when no quotes repo is wired; 400 on a malformed body', async () => {
    const bare = new Hono();
    bare.route('/quote', quoteRoutes({})); // no quotes dep
    expect((await bare.request('/quote/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(501);
    expect((await postLock(createApp({ quotes: new InMemoryQuoteRepo() }), { product: 'private' })).status).toBe(400);
  });
});

describe('POST /quote', () => {
  it('prices a private leg and hides margin from public callers', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCents).toBe(3550); // raw 3542¢ → nearest-50¢ final price
    expect(body.marginEstimateCents).toBeUndefined();
  });

  it('422 with TOO_BIG on an oversize request (pax > custom 99 cap)', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'custom', pax: 120, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('TOO_BIG');
  });

  it('400 on a malformed body', async () => {
    const res = await post(createApp(), { product: 'private' });
    expect(res.status).toBe(400);
  });

  it('includes marginEstimateCents only when x-internal-key matches', async () => {
    const app = new Hono();
    app.route('/quote', quoteRoutes({ internalKey: 'test-key' }));
    const body = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] };

    const ok = await app.request('/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'test-key' },
      body: JSON.stringify(body),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).marginEstimateCents).toBeDefined();

    const stripped = await app.request('/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect(stripped.status).toBe(200);
    expect((await stripped.json()).marginEstimateCents).toBeUndefined();
  });
});

describe('POST /quote — validation & security gaps', () => {
  it('wrong x-internal-key strips marginEstimateCents (security)', async () => {
    const app = new Hono();
    app.route('/quote', quoteRoutes({ internalKey: 'test-key' }));
    const res = await app.request('/quote', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-key': 'wrong-key' },
      body: JSON.stringify({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).marginEstimateCents).toBeUndefined();
  });

  it('unknown extra code → 400 invalid_request (Zod rejects before engine)', async () => {
    const res = await post(createApp(), {
      product: 'private', vehicle: 'car', pax: 2, bags: 2,
      legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }],
      extras: ['bogus'],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });

  it('empty legs array → 400 (Zod .min(1))', async () => {
    const res = await post(createApp(), {
      product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});
