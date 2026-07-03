import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeMapsAdapter, type MapsAdapter } from '../adapters/maps';

const valid = {
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  dates: ['2026-07-20', '2026-07-22'],
  pax: 2,
  vehicleType: 'van',
  serviceType: 'private',
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

async function postTrip(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/bookings/trip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/trip', () => {
  it('creates a trip draft (201) priced by the placeholder when no stop resolves', async () => {
    const app = createApp();
    const res = await postTrip(app, valid);
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('trip');
    expect(b.status).toBe('draft');
    expect(b.total).toBe(12000); // fallback stub: 2 legs × (5000 + 1000 van)
    expect(b.input.stops).toHaveLength(3);
  });

  it('prices a resolvable private trip with the engine, due in full now (GL-3)', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'], nights: [1, 2, 0] });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.total).toBe(18426); // van legs: CMB→Kandy 10292 + Kandy→Ella 8134
    expect(b.amountDueNow).toBe(18426);
  });

  it('prices a resolvable chauffeur trip with the engine and collects only the deposit (GL-3)', async () => {
    const app = createApp();
    const res = await postTrip(app, {
      ...valid,
      stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
      nights: [1, 2, 0],
      vehicleType: 'car',
      serviceType: 'chauffeur',
      dates: ['2026-07-20', '2026-07-22'],
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    // 3 days × 3500 + round((222 buffered + 100 idle-min) × 46) = 10500 + 14812
    expect(b.total).toBe(25312);
    expect(b.amountDueNow).toBe(2531); // 10% deposit, under the $50 cap
  });

  it('rejects an invalid trip (400)', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, stops: ['only one'] });
    expect(res.status).toBe(400);
  });

  it('enriches with summed road distance + duration when all stops are known (M8)', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'], nights: [1, 2, 0] });
    const b = await res.json();
    expect(b.distanceKm).toBeGreaterThan(0);
    expect(b.durationMin).toBeGreaterThan(0);
  });

  it('leaves distance null when any stop is unknown/typed (best-effort, never blocks)', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', '17 Random Lane', 'Ella'], nights: [1, 2, 0] });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.distanceKm).toBeNull();
  });

  it('resolves each leg once per request — pricing + enrichment share the billed lookups', async () => {
    const fake = new FakeMapsAdapter();
    let calls = 0;
    const counting: MapsAdapter = {
      provider: 'counting',
      distance: (f, t) => { calls++; return fake.distance(f, t); },
      places: (q) => fake.places(q),
    };
    const app = createApp({ maps: counting });
    await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'], nights: [1, 2, 0] });
    expect(calls).toBe(2); // one per leg, not doubled by the M8 enrichment
  });

  it('records chauffeur days + driver nights', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...valid, serviceType: 'chauffeur', days: 3, driverNights: 2 });
    expect(res.status).toBe(201);
    const b = await res.json();
    const got = await (await app.request(`/bookings/${b.id}`)).json();
    expect(got.input.days).toBe(3);
    expect(got.input.driverNights).toBe(2);
  });

  it('flows through checkout → webhook → paid → email', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const app = createApp({ adapter, email });

    const b = await (await postTrip(app, valid)).json();
    await app.request(`/bookings/${b.id}/checkout`, { method: 'POST' });
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const wh = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(wh.status).toBe(200);

    const paid = await (await app.request(`/bookings/${b.id}`)).json();
    expect(paid.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].html).toContain('Sigiriya'); // trip route line
  });
});
