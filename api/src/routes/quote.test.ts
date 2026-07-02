import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from '../app';
import { quoteRoutes } from './quote';


function post(app: ReturnType<typeof createApp>, body: unknown, headers: Record<string, string> = {}) {
  return app.request('/quote', { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
}

describe('POST /quote', () => {
  it('prices a private leg and hides margin from public callers', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.totalCents).toBe(4048); // 80km → bill 88km × 46¢ = 4048
    expect(body.marginEstimateCents).toBeUndefined();
  });

  it('422 with TOO_BIG on an oversize request', async () => {
    const res = await post(createApp(), { product: 'private', vehicle: 'van', pax: 9, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] });
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
