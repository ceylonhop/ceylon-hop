import { describe, it, expect } from 'vitest';
import { quoteBreakdown } from './breakdown';
import type { QuoteRequest } from './types';

describe('quoteBreakdown', () => {
  it('private: per-leg billable + price and km totals (140km van = 12782¢)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'van', pax: 4, bags: 4, legs: [{ from: 'Kandy', to: 'Ella', distanceKm: 140 }] };
    const b = quoteBreakdown(req);
    expect(b.legs).toEqual([{ from: 'Kandy', to: 'Ella', distanceKm: 140, billableKm: 154, priceCents: 12782 }]);
    expect(b.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
  });

  it('private: floor applies on a short leg (car, 20km → floor 2900¢)', () => {
    const req: QuoteRequest = { product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [{ from: 'A', to: 'B', distanceKm: 20 }] };
    const b = quoteBreakdown(req);
    expect(b.legs[0].priceCents).toBe(2900); // max(floor, round(22*46))
    expect(b.km.billableKm).toBe(22);
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
});

function billableSum(km: number): number { return Math.round(km * 1.1); }
