import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp } from './app';
import { issueSessionCookie } from './lib/opsMiddleware';

// /admin/quote/* now requires a session with quote:manage (D-A) — the old
// dev-keyless-bypass these rate-limit tests relied on is gone. Mint a founder
// cookie so the requests actually reach the route and we're testing the
// rate limiter, not the auth gate.
const auth = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
async function founderCookie() {
  const c = new Hono();
  c.get('/', (ctx) => { issueSessionCookie(ctx, 'f@x.com', 'sek', Date.now()); return ctx.text('ok'); });
  const res = await c.request('/');
  return res.headers.get('set-cookie')!.split(';')[0];
}

const body = {
  from: 'Colombo Airport (CMB)',
  to: 'Galle',
  vehicleType: 'car',
  adults: 1,
  children: 0,
  bags: 0,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

function post(app: ReturnType<typeof createApp>, ip = '1.2.3.4') {
  return app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

describe('rate limiting (booking writes)', () => {
  it('allows up to the limit, then 429 with Retry-After', async () => {
    const app = createApp({ rateLimit: { max: 2, windowMs: 60000 } });
    expect((await post(app)).status).toBe(201);
    expect((await post(app)).status).toBe(201);
    const blocked = await post(app);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await blocked.json()).error).toBe('rate_limited');
  });

  it('tracks the limit per IP', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    expect((await post(app, '10.0.0.1')).status).toBe(201);
    expect((await post(app, '10.0.0.1')).status).toBe(429);
    expect((await post(app, '10.0.0.2')).status).toBe(201); // a different IP is unaffected
  });

  it('does not limit reads', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    await post(app, '9.9.9.9'); // spend the POST budget for this IP
    for (let i = 0; i < 3; i++) {
      const r = await app.request('/bookings/does-not-exist', { headers: { 'x-forwarded-for': '9.9.9.9' } });
      expect(r.status).toBe(404); // GET passes through, never 429
    }
  });

  // GL-3 — only the RIGHTMOST x-forwarded-for entry is appended by the trusted proxy
  // (Render); everything left of it is client-supplied and trivially spoofable.
  it('keys on the rightmost forwarded entry — spoofed leftmost hops cannot evade the limit', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    expect((await post(app, 'spoof-1, 8.8.8.8')).status).toBe(201);
    expect((await post(app, 'spoof-2, 8.8.8.8')).status).toBe(429); // same trusted hop → same bucket
    expect((await post(app, 'spoof-2, 7.7.0.1')).status).toBe(201); // a genuinely different client
  });

  it('ignores the spoofable x-real-ip header — unattributable requests share one bucket', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    const hit = (realIp: string) =>
      app.request('/bookings/single', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-real-ip': realIp },
        body: JSON.stringify(body),
      });
    expect((await hit('1.1.1.1')).status).toBe(201);
    expect((await hit('2.2.2.2')).status).toBe(429); // rotating x-real-ip buys nothing
  });
});

describe('rate limiting (/admin/quote/* — billed Google APIs + DB writes)', () => {
  it('GET /admin/quote/places 429s past 4x the configured max (autocomplete bursts GETs)', async () => {
    const app = createApp({ rateLimit: { max: 2, windowMs: 60000 }, auth, adminApiKey: 'k' }); // effective GET/POST cap on /admin/quote/* = 8
    const cookie = await founderCookie();
    const hit = (i: number) =>
      app.request(`/admin/quote/places?q=kand${i}`, { headers: { 'x-forwarded-for': '5.5.5.5', cookie } });
    for (let i = 0; i < 8; i++) {
      expect((await hit(i)).status).toBe(200);
    }
    const blocked = await hit(8);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await blocked.json()).error).toBe('rate_limited');
  });

  it('POST /admin/quote/estimate 429s past 4x the configured max', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 }, auth, adminApiKey: 'k' }); // effective cap = 4
    const cookie = await founderCookie();
    const body = { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 10 }] };
    const hit = () =>
      app.request('/admin/quote/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6', cookie },
        body: JSON.stringify(body),
      });
    for (let i = 0; i < 4; i++) {
      expect((await hit()).status).toBe(200);
    }
    expect((await hit()).status).toBe(429);
  });

  it('GET /admin/quote (the 302 redirect to /ops) is NOT throttled — only subpaths match', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/admin/quote', { headers: { 'x-forwarded-for': '7.7.7.7' } });
      expect(r.status).toBe(302);
      expect(r.headers.get('location')).toBe('/ops');
    }
  });
});

describe('CORS allow-list', () => {
  it('reflects an allowed origin', async () => {
    const app = createApp({ allowedOrigins: ['https://ceylonhop.github.io'] });
    const r = await app.request('/health', { headers: { origin: 'https://ceylonhop.github.io' } });
    expect(r.headers.get('access-control-allow-origin')).toBe('https://ceylonhop.github.io');
  });

  it('refuses an unknown origin', async () => {
    const app = createApp({ allowedOrigins: ['https://ceylonhop.github.io'] });
    const r = await app.request('/health', { headers: { origin: 'https://evil.example.com' } });
    expect(r.headers.get('access-control-allow-origin')).toBeNull();
  });
});
