import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { FakePaymentAdapter } from '../adapters/payments';
import { FakeEmailAdapter } from '../adapters/email';
import { FakeMapsAdapter, type MapsAdapter } from '../adapters/maps';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { futureIsoDate } from '../testSupport/dates';

// Anchored to "now" so the past-date rule never expires these (see testSupport/dates).
const tripDates = [futureIsoDate(30), futureIsoDate(32)];

const valid = {
  // Deliberately unresolvable, so the placeholder path is exercised.
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  dates: tripDates,
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
    expect(b.total).toBe(11900); // raw 11999¢ → eligible $119 charm price
    expect(b.amountDueNow).toBe(11900);
  });

  it('prices a resolvable chauffeur trip with the engine and collects the full amount now', async () => {
    const app = createApp();
    const res = await postTrip(app, {
      ...valid,
      stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'],
      nights: [1, 2, 0],
      vehicleType: 'car',
      serviceType: 'chauffeur',
      dates: tripDates,
    });
    expect(res.status).toBe(201);
    const b = await res.json();
    // 3 days × 3105 + round((222 buffered + 50 idle-min) × 40.25) = 9315 + 10948
    expect(b.total).toBe(19900);
    expect(b.amountDueNow).toBe(19900);
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
      distanceVariants: (f, t) => fake.distanceVariants(f, t),
      places: (q) => fake.places(q),
    };
    const app = createApp({ maps: counting });
    await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'], nights: [1, 2, 0] });
    expect(calls).toBe(2); // one per leg, not doubled by the M8 enrichment
  });

  it('records chauffeur days + driver nights', async () => {
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ bookings });
    const res = await postTrip(app, { ...valid, serviceType: 'chauffeur', days: 3, driverNights: 2 });
    expect(res.status).toBe(201);
    const b = await res.json();
    const got = await bookings.get(b.id);
    if (!got || got.mode !== 'trip') throw new Error('expected a trip booking');
    expect(got.input.days).toBe(3);
    expect(got.input.driverNights).toBe(2);
  });

  it('flows through checkout → webhook → paid → email', async () => {
    const adapter = new FakePaymentAdapter();
    const email = new FakeEmailAdapter();
    const bookings = new InMemoryBookingRepo();
    const app = createApp({ adapter, email, bookings });

    // Resolvable stops: this test is about the checkout→webhook→paid pipeline, and an unpriced
    // booking is deliberately not chargeable.
    const b = await (await postTrip(app, { ...valid, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'] })).json();
    await app.request(`/bookings/${b.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${b.checkoutToken}` },
    });
    const body = adapter.simulateWebhook({ orderId: b.reference, amount: b.total, currency: b.currency });
    const wh = await app.request('/webhooks/payments', { method: 'POST', body });
    expect(wh.status).toBe(200);

    const paid = await bookings.get(b.id);
    expect(paid!.status).toBe('paid');
    expect(email.sent).toHaveLength(1);
    expect(email.sent[0].html).toContain('Kandy'); // trip route line
  });
});

// A planner "gap" is a stretch the traveller arranges themselves (plan.js:753 tells them "we won't
// add or charge for this stretch"). booking.js prices it at $0 and leaves it out of the estimate
// intent (booking.js:1462-1468), so the booking must be charged for the driven legs only.
describe('POST /bookings/trip — a self-arranged gap is not charged', () => {
  // CMB → Kandy (we drive) · Kandy → Ella (the traveller's own train, wire 1) · Ella → Galle (we drive)
  const stops = ['Colombo Airport (CMB)', 'Kandy', 'Ella', 'Galle'];
  const gapped = {
    ...valid,
    stops,
    nights: [0, 1, 1, 0],
    dates: [futureIsoDate(30), '', futureIsoDate(33)], // plan.js never dates a gap wire
    vehicleType: 'car',
  };

  it('charges only the driven legs, matching the estimate the booking page showed', async () => {
    const conciergeTasks = new InMemoryConciergeTaskRepo();
    const app = createApp({ quoteV2Enabled: true, conciergeTasks });
    // Exactly buildEstimateIntent()'s private-trip intent: one leg per NON-gap wire.
    const shown = await (await app.request('/quote/v2/estimate', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        product: 'private', vehicle: 'car', pax: 2, bags: 0, extras: [],
        legs: [{ from: stops[0], to: stops[1] }, { from: stops[2], to: stops[3] }],
      }),
    })).json();
    expect(shown.totalCents).toBeGreaterThan(0);

    const res = await postTrip(app, { ...gapped, gaps: [1], quotedTotal: shown.totalCents });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.total).toBe(shown.totalCents);
    expect(await conciergeTasks.listByBooking(b.id)).toHaveLength(0); // no price-mismatch flag
  });

  it('never measures the gap — pricing and the distance enrichment look up the driven legs only', async () => {
    const fake = new FakeMapsAdapter();
    const asked: string[] = [];
    const counting: MapsAdapter = {
      provider: 'counting',
      distance: (f, t) => { asked.push(`${f} → ${t}`); return fake.distance(f, t); },
      distanceVariants: (f, t) => fake.distanceVariants(f, t),
      places: (q) => fake.places(q),
    };
    const app = createApp({ maps: counting });
    const b = await (await postTrip(app, { ...gapped, gaps: [1] })).json();
    expect(asked).toEqual(['Colombo Airport (CMB) → Kandy', 'Ella → Galle']);
    const driven = (await fake.distance(stops[0], stops[1]))!.km + (await fake.distance(stops[2], stops[3]))!.km;
    expect(b.distanceKm).toBe(Math.round(driven));
  });

  it('an unpriceable gapped trip falls back to a placeholder for the driven legs only', async () => {
    const app = createApp();
    const res = await postTrip(app, { ...gapped, stops: ['Nowhere', 'Elsewhere', 'Somewhere', 'Anywhere'], gaps: [1] });
    expect(res.status).toBe(201);
    expect((await res.json()).total).toBe(10000); // fallback stub: 2 driven legs × 5000 (car), not 3
  });

  it.each([
    ['a wire the trip does not have', { gaps: [3] }],
    ['the same wire twice', { gaps: [1, 1] }],
    ['every wire (nothing left for us to drive)', { gaps: [0, 1, 2] }],
    ['a chauffeur-guide, who keeps the car for the whole trip', { gaps: [1], serviceType: 'chauffeur' }],
  ])('refuses gaps naming %s (400)', async (_label, extra) => {
    const res = await postTrip(createApp(), { ...gapped, ...extra });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe('invalid_request');
    expect(body.message).toMatch(/^gaps: /);
  });
});
