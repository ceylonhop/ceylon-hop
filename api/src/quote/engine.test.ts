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

  it('chauffeur: sightseeing + waiting are included in day rate → total unchanged, warnings note both', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withExtras = quote({ ...base, extras: ['sightseeing', 'waiting'] });
    const withoutExtras = quote(base);
    expect(withExtras.totalCents).toBe(withoutExtras.totalCents);
    expect(withExtras.warnings.some((w) => w.includes('sightseeing') && w.includes('included in chauffeur day rate'))).toBe(true);
    expect(withExtras.warnings.some((w) => w.includes('waiting') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('chauffeur: luggage is still charged (not an included extra)', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const withLuggage = quote({ ...base, extras: ['luggage'] });
    expect(withLuggage.totalCents).toBe(withoutExtras.totalCents + RATE_CARD.extras.luggage);
  });

  it('chauffeur: sightseeing + luggage → only luggage added, sightseeing warned as included', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const r = quote({ ...base, extras: ['sightseeing', 'luggage'] });
    expect(r.totalCents).toBe(withoutExtras.totalCents + RATE_CARD.extras.luggage);
    expect(r.warnings.some((w) => w.includes('sightseeing') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('chauffeur: safari-wait is included and not charged', () => {
    const base = {
      product: 'chauffeur' as const, vehicle: 'car' as const, firstDate: '2026-02-14', lastDate: '2026-02-22',
      travelDays: [
        { date: '2026-02-14', from: 'Airport', to: 'Kandy', distanceKm: 120 },
      ],
    };
    const withoutExtras = quote(base);
    const r = quote({ ...base, extras: ['safari-wait'] });
    expect(r.totalCents).toBe(withoutExtras.totalCents);
    expect(r.warnings.some((w) => w.includes('safari-wait') && w.includes('included in chauffeur day rate'))).toBe(true);
  });

  it('private: sightseeing is still charged (included-in-chauffeur rule does not apply to private)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.totalCents).toBe(4048 + 1000);
    expect(r.warnings.some((w) => w.includes('included in chauffeur day rate'))).toBe(false);
  });

  it('shared total (Hakan $22 incl pickup)', () => {
    const r = quote({ product: 'shared', legs: [{ routeId: 'negombo->sigiriya', seats: 1, seatPriceCents: 1900, colomboPickup: true }] });
    expect(r.totalCents).toBe(2200);
  });

  it('throws TOO_BIG only when pax exceeds custom capacity (>99)', () => {
    expect(() => quote({ product: 'private', vehicle: 'custom', pax: 120, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 10 }] })).toThrow('TOO_BIG');
  });

  it('never undercharges: car requested for 6 pax is priced as the required van', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 6, bags: 1, legs: [{ from: 'A', to: 'B', distanceKm: 100 }] });
    expect(r.totalCents).toBe(9130); // 100km → bill 110km × van 83¢ = 9130, NOT car 46¢
    expect(r.warnings.some((w) => w.includes('vehicle set to van'))).toBe(true);
  });

  // New van9 / van14 / custom tier tests
  it('van9: 140km private (1 leg, pax under cap) → 154 billableKm × 100¢ = 15400¢', () => {
    const r = quote({ product: 'private', vehicle: 'van9', pax: 8, bags: 4, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.totalCents).toBe(15400); // 154km × 100¢
    expect(r.marginEstimateCents).toBe(15400 - Math.round(154 * 80)); // 154 × 80¢ cost = 12320; margin = 3080
  });

  it('van14: 140km private → 154 billableKm × 130¢ = 20020¢', () => {
    const r = quote({ product: 'private', vehicle: 'van14', pax: 12, bags: 8, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.totalCents).toBe(20020); // 154km × 130¢
  });

  it('custom: 140km private → 154 billableKm × 175¢ = 26950¢', () => {
    const r = quote({ product: 'private', vehicle: 'custom', pax: 20, bags: 15, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.totalCents).toBe(26950); // 154km × 175¢
  });

  it('van9: 20km private → floor 6500¢ applies (raw 22km × 100¢ = 2200 < 6500)', () => {
    const r = quote({ product: 'private', vehicle: 'van9', pax: 8, bags: 4, legs: [{ from: 'A', to: 'B', distanceKm: 20 }] });
    expect(r.totalCents).toBe(6500); // floor
    // costCents = round(22 * 80) = 1760; margin = 6500 - 1760 = 4740
    expect(r.marginEstimateCents).toBe(6500 - Math.round(22 * 80));
  });

  it('anti-tamper: car requested for 8 pax is priced as van9 with warning', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 8, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.totalCents).toBe(15400); // van9 price
    expect(r.warnings.some((w) => w.includes('vehicle set to van9'))).toBe(true);
  });

  it('anti-tamper: custom requested for 2 pax is priced as custom (no downgrade)', () => {
    const r = quote({ product: 'private', vehicle: 'custom', pax: 2, bags: 0, legs: [{ from: 'A', to: 'B', distanceKm: 140 }] });
    expect(r.totalCents).toBe(26950); // custom 154km × 175¢
    expect(r.warnings.filter((w) => w.includes('vehicle set to'))).toHaveLength(0); // no warning — custom is already >= required (car)
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
