// api/src/quote/engine.test.ts
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';
import type { QuoteRequest } from './types';

describe('quote()', () => {
  it('private single leg with deposit = full total (Tatia Kandy→Nanu Oya 80km→bill 88km = $40.48)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(r.totalCents).toBe(4048); // 88km × 46¢ = 4048
    expect(r.amountDueNowCents).toBe(4048);
    expect(r.rateCardVersion).toBe(RATE_CARD.version);
    expect(r.marginEstimateCents).toBe(792); // 4048 - (88km × 37¢ cost = 3256)
  });

  it('private with extras adds them to the total', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.totalCents).toBe(4048 + 1000);
  });

  it('chauffeur → amountDueNow is the capped deposit (Emma $903.80 → $50)', () => {
    const r = quote({
      product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
        { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
        { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
        { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
      ],
    });
    expect(r.totalCents).toBe(90380);
    expect(r.amountDueNowCents).toBe(5000);
    // billableKm: Math.round(800 * 1.1) = 880 travel + (4 idle days × 100 idle min km) = 1280
    // costCents: Math.round(1280 × 37¢/km) = 47360 → margin = 90380 − 47360 = 43020
    expect(r.marginEstimateCents).toBe(43020);
  });

  it('shared total (Hakan $22 incl pickup)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] });
    expect(r.totalCents).toBe(2200);
  });

  it('throws TOO_BIG when private pax exceeds van', () => {
    expect(() => quote({ product: 'private', vehicle: 'van', pax: 7, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] })).toThrow('TOO_BIG');
  });

  it('never undercharges: car requested for 6 pax is priced as the required van', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 6, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] });
    expect(r.totalCents).toBe(9130); // 100km → bill 110km × van 83¢ = 9130, NOT car 46¢
    expect(r.warnings.some((w) => w.includes('vehicle set to van'))).toBe(true);
  });

  it('throws NO_LEGS on an empty private request', () => {
    expect(() => quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [] })).toThrow('NO_LEGS');
  });

  it('throws NO_LEGS on an empty chauffeur request', () => {
    expect(() => quote({ product: 'chauffeur', vehicle: 'car', firstDate: '2026-01-01', lastDate: '2026-01-01', travelDays: [] })).toThrow('NO_LEGS');
  });

  it('shared product has marginEstimateCents === null (cost not modelled)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: false }] });
    expect(r.marginEstimateCents).toBeNull();
  });
});

describe('invariants', () => {
  const CASES: { label: string; req: QuoteRequest }[] = [
    {
      label: 'private (car, 2 pax, 80 km)',
      req: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] },
    },
    {
      label: 'chauffeur (car, Emma)',
      req: {
        product: 'chauffeur', vehicle: 'car', firstDate: '2026-02-14', lastDate: '2026-02-22',
        travelDays: [
          { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
          { date: '2026-02-16', from: 'Kandy', to: 'Sigiriya day trip', distanceKm: 200 },
          { date: '2026-02-17', from: 'Kandy', to: 'Ella', distanceKm: 140 },
          { date: '2026-02-19', from: 'Ella', to: 'Bentota', distanceKm: 230 },
          { date: '2026-02-22', from: 'Bentota', to: 'Airport', distanceKm: 110 },
        ],
      },
    },
    {
      label: 'shared (Hakan, 1 seat + pickup)',
      req: { product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] },
    },
  ];

  for (const { label, req } of CASES) {
    it(`${label}: totalCents is a non-negative integer`, () => {
      const r = quote(req);
      expect(r.totalCents).toBeGreaterThanOrEqual(0);
      expect(Number.isInteger(r.totalCents)).toBe(true);
    });
    it(`${label}: depositCents does not exceed RATE_CARD cap`, () => {
      const r = quote(req);
      expect(r.depositCents).toBeLessThanOrEqual(RATE_CARD.deposit.capCents);
    });
    it(`${label}: amountDueNowCents does not exceed totalCents`, () => {
      const r = quote(req);
      expect(r.amountDueNowCents).toBeLessThanOrEqual(r.totalCents);
    });
    it(`${label}: every lineItem.amountCents is an integer`, () => {
      const r = quote(req);
      for (const item of r.lineItems) {
        expect(Number.isInteger(item.amountCents)).toBe(true);
      }
    });
  }
});
