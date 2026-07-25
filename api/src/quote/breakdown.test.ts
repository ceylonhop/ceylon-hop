import { describe, it, expect } from 'vitest';
import { quoteBreakdown } from './breakdown';
import type { QuoteRequest } from './types';

describe('quoteBreakdown', () => {
  it('private: per-leg billable + price and km totals (140km van = 8324¢)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'van', pax: 4, bags: 4, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }] };
    const b = quoteBreakdown(req);
    expect(b.legs).toEqual([{ from: 'Kandy', to: 'Ella', distanceKm: 140, billableKm: 154, priceCents: 8324, cls: 'van', minApplied: false }]);
    expect(b.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
    // raw = round(154 * 54.05) = 8324 >= floor 5000 → minApplied false
    expect(b.legs[0].minApplied).toBe(false);
    expect(b.legs[0].cls).toBe('van');
  });

  it('private: floor applies on a short leg (car, 20km → floor 2900¢) — pax:1 so no vehicle upgrade', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ from: 'A', to: 'B', distanceKm: 20 }] };
    const b = quoteBreakdown(req);
    expect(b.legs[0].priceCents).toBe(2900); // max(floor, round(25*40.25))
    expect(b.km.billableKm).toBe(25);
    // raw = round(25 * 40.25) = 1006 < floor 2900 → minApplied true
    expect(b.legs[0].minApplied).toBe(true);
    expect(b.legs[0].cls).toBe('car');
  });

  it('chauffeur: uses travelDays for the per-leg breakdown', () => {
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-16',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Ella', distanceKm: 140 },
      ],
    };
    const b = quoteBreakdown(req);
    expect(b.legs.map((l) => l.distanceKm)).toEqual([120, 140]);
    expect(b.km.distanceKm).toBe(260);
    expect(b.km.billableKm).toBe(billableSum(120) + billableSum(140));
  });

  // --- V3 fix: breakdown must price using the engine's anti-tamper vehicle upgrade ---
  it('private: 8 pax/2 bags with car requested is priced at van9 (capacity upgrade), not car (V3 regression)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 8, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] };
    const b = quoteBreakdown(req);
    expect(b.legs[0]).toEqual({ from: 'A', to: 'B', distanceKm: 140, billableKm: 154, priceCents: 8324, cls: 'van9', minApplied: false });
  });

  // --- V2 fix: chauffeur per-leg prices are the km-charge share only, no per-leg floor ---
  it('chauffeur: per-leg price is km-charge only, NOT the private floor formula (V2 regression)', () => {
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-14',
      travelDays: [{ date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 20 }],
    };
    const b = quoteBreakdown(req);
    // billableKm(20) = 20 + 5km min buffer = 25; km-charge = round(25*40.25) = 1006 (NOT floor 2900)
    expect(b.legs[0].billableKm).toBe(25);
    expect(b.legs[0].priceCents).toBe(1006);
    expect(b.legs[0].minApplied).toBe(false);
    expect(b.legs[0].cls).toBe('car');
  });

  it('chauffeur: vehicle is NOT upgraded (no pax field on chauffeur requests) — stays req.vehicle', () => {
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-14',
      travelDays: [{ date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 20 }],
    };
    const b = quoteBreakdown(req);
    expect(b.legs[0].cls).toBe('car');
  });

  // ── Multi-stop rides (phase 1): a Ride with ≥3 stops collapses to ONE row whose from/to are
  // the first/last stop, distanceKm is the segment sum, billableKm is the single-ride buffer, and
  // it carries a `stops` array. Old-shape (2-stop) rows must NOT gain a `stops` key (GC-4). ──────
  it('private: a 3-stop ride → one row with stops, from/to = first/last, single-ride buffer', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 2, bags: 2,
      legs: [{ stops: ['Kandy', 'Dambulla', 'Habarana'], segmentKms: [72, 23] }] };
    const b = quoteBreakdown(req);
    expect(b.legs).toHaveLength(1);
    expect(b.legs[0]).toEqual({
      from: 'Kandy', to: 'Habarana', stops: ['Kandy', 'Dambulla', 'Habarana'],
      distanceKm: 95, billableKm: 105, priceCents: 4226, cls: 'car', minApplied: false,
    });
    expect(b.km).toEqual({ distanceKm: 95, bufferKm: 10, billableKm: 105 });
  });

  it('private: an old-shape (2-stop) row has NO stops key', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'van', pax: 4, bags: 4,
      legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }] };
    const b = quoteBreakdown(req);
    expect(b.legs[0]).not.toHaveProperty('stops');
  });

  it('chauffeur: a 3-stop ride day → one row with stops, minApplied stays false (no floor)', () => {
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-14',
      travelDays: [{ date: '2026-02-14', stops: ['A', 'B', 'C'], segmentKms: [100, 50] }],
    };
    const b = quoteBreakdown(req);
    expect(b.legs).toHaveLength(1);
    // raw 150 → billable 165 (single 15km max buffer); km-charge round(165 × 40.25¢) = 6641, no floor
    expect(b.legs[0]).toEqual({
      from: 'A', to: 'C', stops: ['A', 'B', 'C'],
      distanceKm: 150, billableKm: 165, priceCents: 6641, cls: 'car', minApplied: false,
    });
  });
});

function billableSum(km: number): number {
  const buffer = Math.min(15, Math.max(5, Math.round(km * 0.1)));
  return km + buffer;
}

// Hot-zone parity (owner report 2026-07-23): the itinerary leg chips come from quoteBreakdown,
// the money-pane lines from the engine — and the engine boosts zone-touching rides while the
// breakdown didn't, so a boosted leg showed two different prices on the same screen ($115.92
// chip vs $127.51 line). The breakdown must price with the SAME per-ride boost the engine uses.
describe('quoteBreakdown — hot-zone parity with the engine', () => {
  const zones = [{ placeName: 'Pasikuda Beach, Sri Lanka', boostPct: 10 }];

  it('private: a zone-touching leg chip equals the engine line item (+10%)', async () => {
    const { quotePrivateLegs } = await import('./private');
    const { normalizeRide } = await import('./types');
    const { RATE_CARD } = await import('./rateCard');
    const card = { ...RATE_CARD, hotZones: zones };
    const req: QuoteRequest = {
      product: 'private', vehicle: 'car', pax: 2, bags: 2,
      legs: [
        { from: 'Colombo Airport (CMB)', to: 'Pelmadulla, Sri Lanka', distanceKm: 140 },
        { from: 'Colombo Airport (CMB)', to: 'Pasikuda Beach, Sri Lanka', distanceKm: 273 },
      ],
    };
    const b = quoteBreakdown(req, card);
    const engine = quotePrivateLegs(req.legs.map((l) => normalizeRide(l)), 'car', undefined, card);
    // Chip = line item, for the boosted AND the unboosted leg alike.
    expect(b.legs.map((l) => l.priceCents)).toEqual(engine.lineItems.map((li) => li.amountCents));
    // And the boost really is in there: 288 billable × 40.25¢ × 1.10 = 12751.
    expect(b.legs[1].priceCents).toBe(12751);
  });

  it('private: custom-rate tiers stay authoritative — no boost in the chip (D11)', async () => {
    const req: QuoteRequest = {
      product: 'private', vehicle: 'van14', pax: 10, bags: 10, customPerKmCents: 100,
      legs: [{ from: 'Colombo', to: 'Pasikuda Beach, Sri Lanka', distanceKm: 273 }],
    };
    const { RATE_CARD } = await import('./rateCard');
    const b = quoteBreakdown(req, { ...RATE_CARD, hotZones: zones });
    expect(b.legs[0].priceCents).toBe(Math.max(28800, Math.round(288 * 100))); // no ×1.10
  });

  it('chauffeur: a zone-touching travel day boosts its km-share row', async () => {
    const { RATE_CARD } = await import('./rateCard');
    const req: QuoteRequest = {
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-15',
      travelDays: [
        { date: '2026-02-14', from: 'Colombo', to: 'Pasikuda Beach, Sri Lanka', distanceKm: 273 },
        { date: '2026-02-15', from: 'Kandy', to: 'Colombo', distanceKm: 115 },
      ],
    };
    const b = quoteBreakdown(req, { ...RATE_CARD, hotZones: zones });
    expect(b.legs[0].priceCents).toBe(Math.round(288 * RATE_CARD.perKmCents.car * 1.1));
    expect(b.legs[1].priceCents).toBe(Math.round(127 * RATE_CARD.perKmCents.car)); // untouched day: no boost
  });
});
