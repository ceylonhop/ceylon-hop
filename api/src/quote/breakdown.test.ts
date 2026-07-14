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
});

function billableSum(km: number): number {
  const buffer = Math.min(15, Math.max(5, Math.round(km * 0.1)));
  return km + buffer;
}
