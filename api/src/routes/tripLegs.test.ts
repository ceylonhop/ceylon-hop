import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { isoToday } from '../domain/dateRules';
import type { MapsAdapter } from '../adapters/maps';

// Per-leg rides on a PUBLIC trip booking (A2).
//
// The website models a trip as one flat chain of stops — legs are implied by adjacency, so
// there is nothing to hang a stop, a fee or a route choice on. Ops sends leg OBJECTS, each
// its own ride. `legs` closes that gap as a pure GROUPING of the existing chain: it says
// which consecutive hops are one day's journey, and nothing else.
//
// The grouping is not cosmetic. The engine buffers km and applies the vehicle floor per
// RIDE, so [A,B,C] as one ride is priced once, and as two rides is buffered and floored
// twice. That difference is the whole point of the field.
//
// Distances are NEVER sent by the client — the server resolves every segment, exactly as it
// does today for the flat chain.

const SOON = isoToday('Asia/Colombo', new Date(Date.now() + 30 * 86_400_000));
const SOON3 = isoToday('Asia/Colombo', new Date(Date.now() + 32 * 86_400_000));

const customer = {
  firstName: 'Maya',
  lastName: 'Silva',
  email: 'maya@example.com',
  whatsapp: '+34600000000',
  country: 'Spain',
};

// Every hop is 50 km, so a price difference can only come from how the hops were GROUPED.
const flatMaps: MapsAdapter = {
  provider: 'stub',
  places: async () => [],
  distanceVariants: async () => null,
  distance: async () => ({ km: 50, durationMin: 60 }),
};

// One named pair the adapter refuses, for the unresolvable-stop case.
const pickyMaps: MapsAdapter = {
  provider: 'stub',
  places: async () => [],
  distanceVariants: async () => null,
  distance: async (from, to) => (from === 'Nowhere' || to === 'Nowhere' ? null : { km: 50, durationMin: 60 }),
};

const base = {
  nights: [0, 0, 0],
  pax: 2,
  vehicleType: 'car' as const,
  serviceType: 'private' as const,
  customer,
  termsAccepted: true,
};

function post(app: ReturnType<typeof createApp>, body: unknown) {
  return app.request('/bookings/trip', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /bookings/trip — per-leg rides', () => {
  it('prices a grouped ride once, not once per hop', async () => {
    const app = createApp({ maps: flatMaps });

    const grouped = await post(app, {
      ...base,
      stops: ['Colombo', 'Kandy', 'Ella'],
      legs: [{ stops: ['Colombo', 'Kandy', 'Ella'] }],
    });
    const split = await post(app, {
      ...base,
      stops: ['Colombo', 'Kandy', 'Ella'],
      legs: [{ stops: ['Colombo', 'Kandy'] }, { stops: ['Kandy', 'Ella'] }],
    });

    expect(grouped.status).toBe(201);
    expect(split.status).toBe(201);
    const g = await grouped.json();
    const s = await split.json();
    // 100 km buffered once vs 50 km buffered twice — the grouping has to reach the engine.
    expect(g.total).not.toBe(s.total);
    expect(g.total).toBeLessThan(s.total);
  });

  it('splitting into one leg per hop matches the flat chain exactly', async () => {
    const app = createApp({ maps: flatMaps });

    const flat = await post(app, { ...base, stops: ['Colombo', 'Kandy', 'Ella'] });
    const perHop = await post(app, {
      ...base,
      stops: ['Colombo', 'Kandy', 'Ella'],
      legs: [{ stops: ['Colombo', 'Kandy'] }, { stops: ['Kandy', 'Ella'] }],
    });

    expect((await flat.json()).total).toBe((await perHop.json()).total);
  });

  it('leaves the flat-chain path untouched when no legs are sent', async () => {
    const app = createApp({ maps: flatMaps });
    const res = await post(app, { ...base, stops: ['Colombo', 'Kandy', 'Ella'] });
    expect(res.status).toBe(201);
    const b = await res.json();
    expect(b.mode).toBe('trip');
    expect(b.total).toBeGreaterThan(0);
  });

  it('refuses legs that disagree with the stop chain', async () => {
    const app = createApp({ maps: flatMaps });
    // The chain says Colombo → Kandy → Ella; the legs quietly drop Kandy. A booking whose
    // displayed route and priced route differ is the quote→booking bug all over again.
    const res = await post(app, {
      ...base,
      stops: ['Colombo', 'Kandy', 'Ella'],
      legs: [{ stops: ['Colombo', 'Ella'] }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('legs_stops_mismatch');
  });

  it('caps a single ride at 8 stops, as the ops tool does', async () => {
    const app = createApp({ maps: flatMaps });
    const stops = Array.from({ length: 9 }, (_, i) => `Place${i}`);
    const res = await post(app, { ...base, stops, legs: [{ stops }] });
    expect(res.status).toBe(400);
  });

  // The chauffeur engine counts idle days as `span − travelDays.length`, so the grouping
  // decides how many days the car is idle. Both requests below carry the SAME stops and the
  // SAME dates over the same 3-day span — only the grouping differs. If `legs` never reached
  // the day model the two would be identical.
  it('a grouped ride is ONE chauffeur travel day, so the idle-day count follows the grouping', async () => {
    const app = createApp({ maps: flatMaps });
    const stops = ['Colombo', 'Kandy', 'Ella', 'Galle'];
    const dates = [SOON, SOON, SOON3]; // depart Colombo, depart Kandy (mid-ride), depart Ella

    const grouped = await post(app, {
      ...base,
      serviceType: 'chauffeur',
      stops,
      dates,
      legs: [{ stops: ['Colombo', 'Kandy', 'Ella'] }, { stops: ['Ella', 'Galle'] }],
    });
    const split = await post(app, {
      ...base,
      serviceType: 'chauffeur',
      stops,
      dates,
      legs: [{ stops: ['Colombo', 'Kandy'] }, { stops: ['Kandy', 'Ella'] }, { stops: ['Ella', 'Galle'] }],
    });

    expect(grouped.status).toBe(201);
    expect(split.status).toBe(201);
    // 2 travel days over a 3-day span leaves one idle day (billed at the idle minimum km);
    // 3 travel days leaves none. Same span, same day rate — the difference is the idle day.
    expect((await grouped.json()).total).toBeGreaterThan((await split.json()).total);
  });

  it('falls back to hand pricing when a stop inside a ride cannot be resolved', async () => {
    const app = createApp({ maps: pickyMaps });
    const res = await post(app, {
      ...base,
      stops: ['Colombo', 'Nowhere', 'Ella'],
      legs: [{ stops: ['Colombo', 'Nowhere', 'Ella'] }],
    });
    expect(res.status).toBe(201);
    // Same contract as the flat chain: unpriced, flagged for ops, never silently guessed.
    expect((await res.json()).needsPricing).toBe(true);
  });
});
