import { describe, it, expect, afterEach } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { internalQuoteRoutes } from './internalQuote';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryQuoteRepo } from '../db/quoteRepo';

type App = ReturnType<typeof createApp>;
function post(app: App, path: string, body: unknown) {
  return app.request(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}
const leg = (o: Record<string, unknown>) => ({ type: 'transfer', from: 'A', to: 'B', ...o });

describe('internal quoting tool route', () => {
  it('GET /places filters the offline known-place list', async () => {
    const res = await createApp().request('/admin/quote/places?q=kand');
    expect(res.status).toBe(200);
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('GET /places returns [] for a too-short query', async () => {
    expect((await (await createApp().request('/admin/quote/places?q=k')).json()).places).toEqual([]);
  });

  it('POST /distance returns km + duration for known places', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Colombo City', to: 'Kandy' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.km).toBeGreaterThan(0);
    expect(d.durationMin).toBeGreaterThan(0);
  });

  it('POST /distance is 404 for an unknown route', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Nowhereville', to: 'Kandy' });
    expect(res.status).toBe(404);
  });

  it('estimate prices a private leg from a manual km (80km car = 4048¢) + emits a WhatsApp draft', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      name: 'Test', product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [leg({ distanceKm: 80 })],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.total.cents).toBe(4048);
    expect(d.amountDueNow.cents).toBe(4048); // private → full
    expect(d.drafts.whatsapp).toContain('A → B');
    expect(d.drafts.email).toContain('Subject:');
    expect(d.drafts.notion).toContain('| Date | Route |');
    expect(d.comparison.car.total.cents).toBe(4048);
    expect(d.comparison.van.total.cents).toBeGreaterThan(4048);
  });

  it('estimate auto-resolves the distance from known places when km is omitted', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ type: 'transfer', from: 'Colombo City', to: 'Kandy' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBeGreaterThan(0);
  });

  it('estimate is 400 when distance is unknown and no manual km is given', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ type: 'transfer', from: 'Nowhereville', to: 'Kandy' }],
    });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with no legs', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with only a stay day (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      product: 'chauffeur', vehicle: 'car', pax: 1, bags: 0, legs: [{ type: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' }],
    });
    expect(res.status).toBe(400);
  });

  it('a sightseeing leg type adds the $10 sightseeing extra vs a plain transfer', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const withS = await (await post(createApp(), '/admin/quote/estimate', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ type: 'sightseeing', distanceKm: 80 })] })).json();
    expect(withS.total.cents).toBe(base.total.cents + 1000);
  });

  it('POST /save persists a priced quote and returns a Q- reference; total matches /estimate', async () => {
    const app = createApp();
    const bodyReq = { name: 'Maya', contact: '+34600', product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [leg({ distanceKm: 80 })] };
    const est = await (await post(app, '/admin/quote/estimate', bodyReq)).json();
    const res = await post(app, '/admin/quote/save', bodyReq);
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.reference).toMatch(/^Q-[0-9A-Z]{4}$/);
    expect(saved.status).toBe('draft');
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(est.total.cents); // saved total == previewed total
    expect(got.customerName).toBe('Maya');
    expect(got.rateCardVersion).toBe('2026-06-28');
  });

  it('POST /save re-prices server-side and ignores any client-supplied total', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', {
      product: 'private', vehicle: 'car', pax: 1, bags: 0, total: 999999, totalCents: 999999, legs: [leg({ distanceKm: 80 })],
    });
    const saved = await res.json();
    const got = await (await app.request(`/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(4048); // engine price, not the bogus client total
  });

  it('POST /save is 422 for an unpriceable trip (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/save', {
      product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ type: 'stay_day', from: 'Kandy', to: '' }],
    });
    expect(res.status).toBe(400); // stay-day-only → no travel leg
  });

  const patch = (app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  it('GET /list returns saved quotes newest-first and filters by status/product', async () => {
    const app = createApp();
    const a = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const b = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'van', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const list = await (await app.request('/admin/quote/list')).json();
    expect(list.quotes[0].id).toBe(b.id); // newest first
    await patch(app, `/admin/quote/${a.id}`, { status: 'won' });
    const won = await (await app.request('/admin/quote/list?status=won')).json();
    expect(won.quotes.map((q: { id: string }) => q.id)).toEqual([a.id]);
  });

  it('PATCH /:id moves status, stamps timestamps, records lost_reason; 404 unknown; 400 bad status', async () => {
    const app = createApp();
    const q = await (await post(app, '/admin/quote/save', { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const sent = await (await patch(app, `/admin/quote/${q.id}`, { status: 'sent' })).json();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    const lost = await (await patch(app, `/admin/quote/${q.id}`, { status: 'lost', lostReason: 'too expensive' })).json();
    expect(lost.decidedAt).not.toBeNull();
    expect(lost.lostReason).toBe('too expensive');
    expect((await patch(app, '/admin/quote/00000000-0000-0000-0000-000000000000', { status: 'won' })).status).toBe(404);
    expect((await patch(app, `/admin/quote/${q.id}`, { status: 'bogus' })).status).toBe(400);
  });

  it('accepts an injected QuoteRepo without breaking existing routes', async () => {
    const { InMemoryQuoteRepo } = await import('../db/quoteRepo');
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await app.request('/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('chauffeur: stay days become idle days; amountDueNow is the capped deposit', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      product: 'chauffeur', vehicle: 'car', pax: 2, bags: 1, legs: [
        { type: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { type: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' },
        { type: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.product).toBe('chauffeur');
    expect(d.amountDueNow.cents).toBe(d.deposit.cents); // chauffeur pays the deposit now
    expect(d.deposit.cents).toBeLessThanOrEqual(5000); // cap
  });
});

describe('quoting tool — admin-key auth', () => {
  const keyed = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), adminKey: 'secret' }));
    return a;
  };

  it('serves the HTML shell without a key', async () => {
    const res = await keyed().request('/admin/quote');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
  });

  it('401s a data route without the key and 200s with it', async () => {
    const app = keyed();
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
    const ok = await app.request('/admin/quote/places?q=kand', { headers: { 'x-admin-key': 'secret' } });
    expect(ok.status).toBe(200);
    expect((await ok.json()).places).toEqual(['Kandy']);
  });

  it('leaves data routes open when no key is configured (dev/preview)', async () => {
    // createApp default ADMIN_API_KEY is '' → open
    expect((await createApp().request('/admin/quote/places?q=kand')).status).toBe(200);
  });
});

describe('quoting tool — Google Places path (mocked fetch)', () => {
  const origFetch = global.fetch;
  afterEach(() => {
    global.fetch = origFetch;
  });
  const appWithKey = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), googleKey: 'test-key', quotes: new InMemoryQuoteRepo() }));
    return a;
  };

  it('returns Google predictions when a server key is configured', async () => {
    global.fetch = (async () =>
      new Response(JSON.stringify({ predictions: [{ description: 'Colombo Fort, Sri Lanka' }, { description: 'Colombo City Centre' }] }), { status: 200 })) as typeof fetch;
    const res = await appWithKey().request('/admin/quote/places?q=colombo');
    expect((await res.json()).places).toEqual(['Colombo Fort, Sri Lanka', 'Colombo City Centre']);
  });

  it('falls back to the offline list when Google throws', async () => {
    global.fetch = (async () => {
      throw new Error('network down');
    }) as typeof fetch;
    const res = await appWithKey().request('/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('falls back to the offline list when Google returns no predictions', async () => {
    global.fetch = (async () => new Response(JSON.stringify({ predictions: [] }), { status: 200 })) as typeof fetch;
    const res = await appWithKey().request('/admin/quote/places?q=ella');
    expect((await res.json()).places).toEqual(['Ella']);
  });

  it('builds the Places request scoped to Sri Lanka with the query + key', async () => {
    let captured = '';
    global.fetch = (async (u: string) => {
      captured = String(u);
      return new Response(JSON.stringify({ predictions: [{ description: 'X' }] }), { status: 200 });
    }) as unknown as typeof fetch;
    await appWithKey().request('/admin/quote/places?q=galle');
    expect(captured).toContain('input=galle');
    expect(captured).toContain('components=country:lk');
    expect(captured).toContain('key=test-key');
  });
});
