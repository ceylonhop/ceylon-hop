import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { quoteRoutes } from './quote';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { FakeMapsAdapter } from '../adapters/maps';


function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

function postLock(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/quote/lock', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const PRIVATE_LEG = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] };
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const V2_PRIVATE = {
  product: 'private',
  routeId: 'kandy-nanu-oya',
  vehicle: 'car',
  pax: 2,
  bags: 2,
  legs: [{ from: 'Kandy', to: 'Nanu Oya' }],
  extras: [],
};

describe('public quote v2 lock', () => {
  function v2App(
    quotes = new InMemoryQuoteRepo(),
    now: () => Date = () => new Date('2026-07-28T12:00:00.000Z'),
  ) {
    const app = new Hono();
    app.route('/quote', quoteRoutes({
      quotes,
      maps: new FakeMapsAdapter(),
      v2Enabled: true,
      now,
    }));
    return { app, quotes };
  }

  it('is default-off and leaves the legacy lock unchanged', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    expect(
      (await app.request('/quote/v2/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(V2_PRIVATE),
      })).status,
    ).toBe(404);
    expect((await postLock(app, PRIVATE_LEG)).status).toBe(201);
  });

  it('creates a server-resolved quote with a fixed expiry and one-time access token', async () => {
    const { app, quotes } = v2App();
    const res = await app.request('/quote/v2/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...V2_PRIVATE, distanceKm: undefined }),
    });

    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body).toMatchObject({ revision: 1, totalCents: expect.any(Number) });
    expect(body.accessToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(new Date(body.expiresAt).toISOString()).toBe('2026-08-04T12:00:00.000Z');
    expect(body.marginEstimateCents).toBeUndefined();

    const saved = await quotes.get(body.quoteId);
    expect(saved).toMatchObject({
      channel: 'web',
      revision: 1,
      intentFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    expect(saved?.request).toHaveProperty('engine');
    expect(saved?.request).toHaveProperty('intent');
    expect(saved?.accessTokenDigest).not.toBe(body.accessToken);
  });

  it('server-resolves and stores a chauffeur quote without client distances', async () => {
    const { app, quotes } = v2App();
    const intent = {
      product: 'chauffeur',
      tourId: 'hill-country-2d',
      vehicle: 'car',
      pax: 2,
      bags: 2,
      firstDate: '2026-09-10',
      lastDate: '2026-09-11',
      travelDays: [
        { date: '2026-09-10', from: 'Kandy', to: 'Nanu Oya' },
        { date: '2026-09-11', from: 'Nanu Oya', to: 'Ella' },
      ],
      extras: [],
    };
    const res = await app.request('/quote/v2/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(intent),
    });
    expect(res.status).toBe(201);
    const body = await res.json();
    const saved = await quotes.get(body.quoteId);
    expect(saved?.product).toBe('chauffeur');
    expect((saved?.request as { engine: { travelDays: { distanceKm: number }[] } }).engine.travelDays)
      .toEqual([
        expect.objectContaining({ distanceKm: expect.any(Number) }),
        expect.objectContaining({ distanceKm: expect.any(Number) }),
      ]);
  });

  it('updates only with the current token/revision and never extends expiry', async () => {
    let now = new Date('2026-07-28T12:00:00.000Z');
    const { app } = v2App(new InMemoryQuoteRepo(), () => now);
    const created = await (
      await app.request('/quote/v2/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(V2_PRIVATE),
      })
    ).json();
    now = new Date('2026-07-29T12:00:00.000Z');
    const changed = { ...V2_PRIVATE, bags: 3 };
    const updated = await app.request(`/quote/v2/${created.quoteId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.accessToken}`,
      },
      body: JSON.stringify({ revision: 1, intent: changed }),
    });

    expect(updated.status).toBe(200);
    const body = await updated.json();
    expect(body.revision).toBe(2);
    expect(body.expiresAt).toBe(created.expiresAt);
    expect(body.accessToken).toBeUndefined();

    const stale = await app.request(`/quote/v2/${created.quoteId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.accessToken}`,
      },
      body: JSON.stringify({ revision: 1, intent: changed }),
    });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toBe('stale_revision');
  });

  it.each([
    [undefined, 'missing'],
    ['Bearer forged', 'forged'],
  ])('rejects %s access token', async (...[authorization]: [string | undefined, string]) => {
    const { app } = v2App();
    const created = await (
      await app.request('/quote/v2/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(V2_PRIVATE),
      })
    ).json();
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (authorization) headers.authorization = authorization;
    const res = await app.request(`/quote/v2/${created.quoteId}`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ revision: 1, intent: V2_PRIVATE }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('quote_access_denied');
  });

  it('rejects an update after the fixed quote expiry', async () => {
    let now = new Date('2026-07-28T12:00:00.000Z');
    const { app } = v2App(new InMemoryQuoteRepo(), () => now);
    const created = await (
      await app.request('/quote/v2/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(V2_PRIVATE),
      })
    ).json();
    now = new Date('2026-08-05T12:00:00.000Z');
    const res = await app.request(`/quote/v2/${created.quoteId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${created.accessToken}`,
      },
      body: JSON.stringify({ revision: 1, intent: V2_PRIVATE }),
    });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('quote_expired');
  });

  it('rejects a token issued for a different quote', async () => {
    const { app } = v2App();
    const create = async () => {
      const response = await app.request('/quote/v2/lock', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(V2_PRIVATE),
      });
      return response.json();
    };
    const [first, second] = await Promise.all([create(), create()]);

    const res = await app.request(`/quote/v2/${second.quoteId}`, {
      method: 'PUT',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${first.accessToken}`,
      },
      body: JSON.stringify({ revision: 1, intent: V2_PRIVATE }),
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('quote_access_denied');
  });

  it('fails closed when Maps cannot produce a chargeable road distance', async () => {
    const maps = new FakeMapsAdapter();
    maps.distance = async () => null;
    const app = new Hono();
    app.route('/quote', quoteRoutes({
      quotes: new InMemoryQuoteRepo(),
      maps,
      v2Enabled: true,
    }));

    const res = await app.request('/quote/v2/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(V2_PRIVATE),
    });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('quote_unpriced');
  });

  it('rejects client-authored price and distance fields at the route boundary', async () => {
    const { app } = v2App();
    const res = await app.request('/quote/v2/lock', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...V2_PRIVATE, totalCents: 1, distanceKm: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid_request');
  });
});

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
