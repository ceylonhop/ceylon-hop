import { describe, it, expect } from 'vitest';
import { createApp } from './app';

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
});

describe('rate limiting (/admin/quote/* — billed Google APIs + DB writes)', () => {
  it('GET /admin/quote/places 429s past 4x the configured max (autocomplete bursts GETs)', async () => {
    const app = createApp({ rateLimit: { max: 2, windowMs: 60000 } }); // effective GET/POST cap on /admin/quote/* = 8
    const hit = (i: number) =>
      app.request(`/admin/quote/places?q=kand${i}`, { headers: { 'x-forwarded-for': '5.5.5.5' } });
    for (let i = 0; i < 8; i++) {
      expect((await hit(i)).status).toBe(200);
    }
    const blocked = await hit(8);
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get('retry-after')).toBeTruthy();
    expect((await blocked.json()).error).toBe('rate_limited');
  });

  it('POST /admin/quote/estimate 429s past 4x the configured max', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } }); // effective cap = 4
    const body = { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 10 }] };
    const hit = () =>
      app.request('/admin/quote/estimate', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '6.6.6.6' },
        body: JSON.stringify(body),
      });
    for (let i = 0; i < 4; i++) {
      expect((await hit()).status).toBe(200);
    }
    expect((await hit()).status).toBe(429);
  });

  it('GET /admin/quote (the HTML shell) is NOT throttled — only subpaths match', async () => {
    const app = createApp({ rateLimit: { max: 1, windowMs: 60000 } });
    for (let i = 0; i < 10; i++) {
      const r = await app.request('/admin/quote', { headers: { 'x-forwarded-for': '7.7.7.7' } });
      expect(r.status).toBe(200);
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
