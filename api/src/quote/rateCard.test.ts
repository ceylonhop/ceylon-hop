import { describe, it, expect } from 'vitest';
import { RATE_CARD } from './rateCard';

describe('RATE_CARD', () => {
  it('exposes the locked v1 rates in cents (incl. 15% markup)', () => {
    expect(RATE_CARD.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RATE_CARD.currency).toBe('USD');
    expect(RATE_CARD.markupPct).toBe(15);
    expect(RATE_CARD.perKmCents).toMatchObject({ car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 });
    expect(RATE_CARD.floorCents).toMatchObject({ car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 });
    expect(RATE_CARD.chauffeur).toMatchObject({ dayRateCents: 3105, idleMinKm: { car: 50, van: 100, van9: 100, van14: 100, custom: 100 } });
    expect(RATE_CARD.deposit).toEqual({ pct: 10, capCents: 5000 });
    expect(RATE_CARD.vehicle).toMatchObject({
      car: { maxPax: 3, maxBags: 3 },
      van: { maxPax: 6, maxBags: 6 },
      van9: { maxPax: 9, maxBags: 8 },
      van14: { maxPax: 14, maxBags: 12 },
      custom: { maxPax: 99, maxBags: 99 },
    });
    expect(RATE_CARD.extras['safari-wait']).toBe(1900);
    expect(RATE_CARD.shared.colomboPickupCents).toBe(300);
    expect(RATE_CARD.bufferPct).toBe(10);
    expect(RATE_CARD.priceFinishing).toEqual({ maxReductionBps: 250, roundToCents: 50 });
    expect(RATE_CARD.fxUsdToLkr).toBeGreaterThan(0);
    expect(RATE_CARD.extras.waiting).toBe(1000);
  });
});
