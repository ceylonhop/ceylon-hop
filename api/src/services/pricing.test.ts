import { describe, it, expect } from 'vitest';
import { quoteSingleTransfer, quoteTrip, quoteShared, priceSingle, priceTrip, priceShared } from './pricing';
import { FakeMapsAdapter, type MapsAdapter } from '../adapters/maps';
import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

const base: SingleTransferInput = {
  from: 'A',
  to: 'B',
  vehicleType: 'car',
  adults: 1,
  children: 0,
  bags: 0,
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('quoteSingleTransfer (stub)', () => {
  it('prices a car for one adult at the base', () => {
    expect(quoteSingleTransfer(base)).toEqual({ currency: 'USD', total: 4000 });
  });

  it('adds per-extra-adult', () => {
    expect(quoteSingleTransfer({ ...base, adults: 3 }).total).toBe(6000);
  });

  it('adds the van surcharge', () => {
    expect(quoteSingleTransfer({ ...base, vehicleType: 'van', adults: 2 }).total).toBe(7000);
  });

  it('does not charge for children — only adults drive the price', () => {
    const withKids = quoteSingleTransfer({ ...base, adults: 2, children: 3 }).total;
    expect(withKids).toBe(quoteSingleTransfer({ ...base, adults: 2, children: 0 }).total);
    expect(withKids).toBe(5000); // base 4000 + 1 extra adult 1000
  });
});

const trip: TripInput = {
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  pax: 2,
  vehicleType: 'car',
  serviceType: 'private',
  customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('quoteTrip (stub)', () => {
  it('prices private per inter-city leg', () => {
    // 3 stops = 2 legs × 5000 (car)
    expect(quoteTrip(trip)).toEqual({ currency: 'USD', total: 10000 });
  });

  it('adds the van surcharge per leg', () => {
    expect(quoteTrip({ ...trip, vehicleType: 'van' }).total).toBe(12000); // 2 × 6000
  });

  it('prices chauffeur per day (nights + 1)', () => {
    // nights 1+2+0 = 3 -> 4 days × 5500
    expect(quoteTrip({ ...trip, serviceType: 'chauffeur' }).total).toBe(22000);
  });
});

describe('quoteShared (stub)', () => {
  it('prices seats × the corridor seat price', () => {
    expect(quoteShared(3, 3500)).toEqual({ currency: 'USD', total: 10500 });
  });
});

// ── GL-3: engine-backed pricing (the M11 engine is the pricing truth) ────────
// Expected values follow the engine math exactly: km from the fake maps adapter
// (round(haversine × 1.35)), billableKm = round(km × 1.1), leg = max(floor, round(billableKm × rate)).
// Kandy→Ella: km 89 → billable 98 → car round(98×35) = 3430, van max(5000, round(98×47)=4606) = 5000.
// CMB→Kandy: km 113 → billable 124 → car round(124×35) = 4340.

const maps = new FakeMapsAdapter();
const single: SingleTransferInput = { ...base, from: 'Kandy', to: 'Ella', adults: 2, bags: 2 };

describe('priceSingle (engine-backed)', () => {
  it('prices a resolvable route with the engine (car per-km × billable km)', async () => {
    const p = await priceSingle(single, maps);
    expect(p).toEqual({ currency: 'USD', totalCents: 3945, amountDueNowCents: 3945, priced: true });
  });

  it('prices a van at the van rate', async () => {
    const p = await priceSingle({ ...single, vehicleType: 'van' }, maps);
    expect(p).toEqual({ currency: 'USD', totalCents: 5297, amountDueNowCents: 5297, priced: true });
  });

  it('adds priced extras from the payload', async () => {
    const p = await priceSingle({ ...single, extras: ['luggage', 'front'] }, maps);
    // 3945 + luggage 500 + front 800
    expect(p).toEqual({ currency: 'USD', totalCents: 5245, amountDueNowCents: 5245, priced: true });
  });

  it('upgrades the vehicle when the party does not fit (engine authority, never underprice)', async () => {
    const p = await priceSingle({ ...single, adults: 5 }, maps); // 5 pax can't ride a car
    expect(p).toEqual({ currency: 'USD', totalCents: 5297, amountDueNowCents: 5297, priced: true });
  });

  it('returns priced:false when the route cannot be resolved', async () => {
    const p = await priceSingle({ ...single, from: 'Somewhere', to: 'Elsewhere' }, maps);
    expect(p.priced).toBe(false);
    if (!p.priced) expect(p.reason).toBeTruthy();
  });

  it('returns priced:false instead of throwing when the engine rejects the input', async () => {
    const p = await priceSingle({ ...single, adults: 100 }, maps); // too big for any tier
    expect(p.priced).toBe(false);
  });

  it('returns priced:false when the maps adapter itself throws', async () => {
    const broken: MapsAdapter = {
      provider: 'broken',
      distance: async () => { throw new Error('upstream down'); },
      places: async () => [],
    };
    const p = await priceSingle(single, broken);
    expect(p.priced).toBe(false);
  });
});

const knownTrip: TripInput = { ...trip, stops: ['Colombo Airport (CMB)', 'Kandy', 'Ella'] };

describe('priceTrip (engine-backed) — private', () => {
  it('prices each consecutive stop pair as an engine leg', async () => {
    const p = await priceTrip(knownTrip, maps);
    // CMB→Kandy 4991 + Kandy→Ella 3945
    expect(p).toEqual({ currency: 'USD', totalCents: 8936, amountDueNowCents: 8936, priced: true });
  });

  it('returns priced:false when any leg cannot be resolved', async () => {
    const p = await priceTrip({ ...knownTrip, stops: ['Colombo Airport (CMB)', '17 Random Lane', 'Ella'] }, maps);
    expect(p.priced).toBe(false);
  });
});

describe('priceTrip (engine-backed) — chauffeur', () => {
  // travelKm 113 + 89 = 202 → buffered 222; day rate 3105/day (sell); car idle-min 100 km/day.
  it('uses real leg dates for the day span (idle days between dated legs are billed)', async () => {
    const p = await priceTrip(
      { ...knownTrip, serviceType: 'chauffeur', dates: ['2026-07-20', '2026-07-22'] },
      maps,
    );
    // days 3 (20th→22nd), idle 1 → billable 222 + 100 = 322 km
    // 3×3105 + round(322×40.25) = 9315 + 12961 = 22276
    expect(p).toEqual({ currency: 'USD', totalCents: 22276, amountDueNowCents: 22276, priced: true });
  });

  it('synthesizes dates from `days` when the trip is flexible (engine only counts the span)', async () => {
    const p = await priceTrip({ ...knownTrip, serviceType: 'chauffeur', days: 4 }, maps);
    // days 4, 2 travel legs → idle 2 → billable 222 + 200 = 422 km
    // 4×3105 + round(422×40.25) = 12420 + 16986 = 29406
    expect(p).toEqual({ currency: 'USD', totalCents: 29406, amountDueNowCents: 29406, priced: true });
  });

  it('defaults the span to one day per leg when `days` is absent', async () => {
    const p = await priceTrip({ ...knownTrip, serviceType: 'chauffeur' }, maps);
    // days 2, idle 0 → 2×3105 + round(222×40.25) = 6210 + 8936 = 15146
    expect(p).toEqual({ currency: 'USD', totalCents: 15146, amountDueNowCents: 15146, priced: true });
  });

  it('clamps extra legs onto the last day when there are more legs than days', async () => {
    const p = await priceTrip({ ...knownTrip, serviceType: 'chauffeur', days: 1 }, maps);
    // both legs share the single day → days 1, idle 0 → 3105 + round(222×40.25)=8936 = 12041
    expect(p).toEqual({ currency: 'USD', totalCents: 12041, amountDueNowCents: 12041, priced: true });
  });

  it('synthesizes when the payload dates are unusable (blank/partial)', async () => {
    const p = await priceTrip(
      { ...knownTrip, serviceType: 'chauffeur', dates: ['2026-07-20', ''], days: 4 },
      maps,
    );
    expect(p).toEqual({ currency: 'USD', totalCents: 29406, amountDueNowCents: 29406, priced: true });
  });
});

describe('priceShared (engine-agnostic — the corridor DB price is already authoritative)', () => {
  it('prices seats × the corridor seat price, all due now', () => {
    expect(priceShared(3, 2100)).toEqual({ currency: 'USD', totalCents: 6300, amountDueNowCents: 6300, priced: true });
  });
});
