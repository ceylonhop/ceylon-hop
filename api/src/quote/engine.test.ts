// api/src/quote/engine.test.ts
import { describe, it, expect } from 'vitest';
import { quote } from './engine';
import { RATE_CARD } from './rateCard';

describe('quote()', () => {
  it('private single leg with deposit = full total (Tatia Kandy→Nanu Oya $36.80)', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }] });
    expect(r.totalCents).toBe(3680);
    expect(r.amountDueNowCents).toBe(3680);
    expect(r.rateCardVersion).toBe(RATE_CARD.version);
  });

  it('private with extras adds them to the total', () => {
    const r = quote({ product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 }], extras: ['sightseeing'] });
    expect(r.totalCents).toBe(3680 + 1000);
  });

  it('chauffeur → amountDueNow is the capped deposit (Emma $867 → $50)', () => {
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
    expect(r.totalCents).toBe(86700);
    expect(r.amountDueNowCents).toBe(5000);
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
    expect(r.totalCents).toBe(8300); // 100 km × van 83¢, NOT car 46¢
    expect(r.warnings.some((w) => w.includes('vehicle set to van'))).toBe(true);
  });

  it('throws NO_LEGS on an empty private request', () => {
    expect(() => quote({ product: 'private', vehicle: 'car', pax: 1, bags: 0, legs: [] })).toThrow('NO_LEGS');
  });
});
