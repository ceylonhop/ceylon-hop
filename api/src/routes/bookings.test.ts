import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

function post(
  app: ReturnType<typeof createApp>,
  body: unknown,
  headers: Record<string, string> = {},
) {
  return app.request('/bookings/single', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/single', () => {
  it('creates a draft (201) with reference and total', async () => {
    const app = createApp();
    const res = await post(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.reference).toMatch(/^CH-/);
    expect(b.status).toBe('draft');
    expect(b.total).toBe(5000); // unresolvable route, no quotedTotal → placeholder: 4000 + 1×1000
    expect(b.currency).toBe('USD');
  });

  it('prices a resolvable route with the engine, due in full now (GL-3)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.total).toBe(9108); // km 180 → billable 198 → round(198×46)
    expect(b.amountDueNow).toBe(9108);
  });

  it('prices payload extras through the engine (GL-3)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle', extras: ['luggage', 'front'] });
    const b = await res.json();
    expect(b.total).toBe(10408); // 9108 + luggage 500 + child seat 800
  });

  it('enriches the booking with road distance + duration (maps adapter)', async () => {
    const app = createApp();
    const b = await (await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' })).json();
    expect(b.distanceKm).toBeGreaterThan(150); // ~180 km via the fake's haversine estimate
    expect(b.durationMin).toBeGreaterThan(0);
  });

  it('leaves distance null when the route is unrecognised (fake)', async () => {
    const app = createApp();
    const b = await (await post(app, { ...valid, from: 'Somewhere', to: 'Elsewhere' })).json();
    expect(b.distanceKm).toBeNull();
  });

  it('rejects an invalid body (400)', async () => {
    const app = createApp();
    const res = await post(app, { ...valid, adults: 0 });
    expect(res.status).toBe(400);
  });

  it('is idempotent on Idempotency-Key — one booking, second call returns it', async () => {
    const app = createApp();
    const r1 = await post(app, valid, { 'Idempotency-Key': 'abc' });
    const r2 = await post(app, valid, { 'Idempotency-Key': 'abc' });
    expect(r1.status).toBe(201);
    expect(r2.status).toBe(200);
    expect((await r1.json()).id).toBe((await r2.json()).id);
  });
});

describe('GET /bookings/:id', () => {
  it('returns a created booking', async () => {
    const app = createApp();
    const created = await (await post(app, valid)).json();
    const res = await app.request(`/bookings/${created.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).id).toBe(created.id);
  });

  it('404 for an unknown id', async () => {
    const app = createApp();
    const res = await app.request('/bookings/does-not-exist');
    expect(res.status).toBe(404);
  });
});
