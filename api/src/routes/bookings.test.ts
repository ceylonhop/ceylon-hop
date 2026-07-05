import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakeMapsAdapter, type MapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { signBookingToken } from '../lib/bookingToken';

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

  it('resolves each route pair once per request — pricing + enrichment share the billed lookup', async () => {
    const fake = new FakeMapsAdapter();
    let calls = 0;
    const counting: MapsAdapter = {
      provider: 'counting',
      distance: (f, t) => { calls++; return fake.distance(f, t); },
      places: (q) => fake.places(q),
    };
    const app = createApp({ maps: counting });
    await post(app, { ...valid, from: 'Colombo Airport (CMB)', to: 'Galle' });
    expect(calls).toBe(1); // not 2 (engine + M8 enrichment)
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

describe('GET /bookings/view (tokenized customer view)', () => {
  const SECRET = 'dev-booking-link-secret-change-me';

  it('returns a customer-safe projection for a valid token', async () => {
    const bookings = new InMemoryBookingRepo();
    const created = await bookings.create({
      mode: 'single',
      total: 6000,
      amountDueNow: 6000,
      currency: 'USD',
      input: {
        from: 'Colombo Airport (CMB)',
        to: 'Kandy',
        vehicleType: 'car',
        adults: 2,
        children: 0,
        bags: 1,
        customer: { firstName: 'Maya', lastName: 'Fernandez', email: 'maya@example.com', whatsapp: '+94771234567', country: 'Spain' },
      },
    });
    const app = createApp({ bookings });
    const res = await app.request(`/bookings/view?t=${signBookingToken(created.id, SECRET)}`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.reference).toBe(created.reference);
    expect(body.from).toBe('Colombo Airport (CMB)');
    expect(body.firstName).toBe('Maya');
    expect(body.totalCents).toBe(6000);
    // Allow-list: never leak the id, channel, or contact details.
    for (const leak of ['id', 'channel', 'email', 'whatsapp', 'country', 'lastName']) {
      expect(JSON.stringify(body)).not.toContain(leak === 'email' ? 'maya@example.com' : leak === 'whatsapp' ? '+94771234567' : leak === 'country' ? 'Spain' : leak === 'lastName' ? 'Fernandez' : `"${leak}"`);
    }
  });

  it('401s a missing or invalid token', async () => {
    const app = createApp();
    expect((await app.request('/bookings/view')).status).toBe(401);
    expect((await app.request('/bookings/view?t=garbage')).status).toBe(401);
  });

  it('404s a valid signature for an unknown booking', async () => {
    const app = createApp();
    const res = await app.request(`/bookings/view?t=${signBookingToken('no-such-id', SECRET)}`);
    expect(res.status).toBe(404);
  });
});
