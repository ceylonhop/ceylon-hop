import { describe, it, expect } from 'vitest';
import { RATE_CARD } from './rateCard';

describe('RATE_CARD', () => {
  it('exposes the locked v1 rates in cents (incl. 25% markup)', () => {
    expect(RATE_CARD.version).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(RATE_CARD.currency).toBe('USD');
    expect(RATE_CARD.markupPct).toBe(25);
    expect(RATE_CARD.perKmCents).toEqual({ car: 46, van: 83 });
    expect(RATE_CARD.floorCents).toEqual({ car: 2900, van: 5000 });
    expect(RATE_CARD.chauffeur).toEqual({ dayRateCents: 3500, idleMinKm: { car: 100, van: 150 } });
    expect(RATE_CARD.deposit).toEqual({ pct: 10, capCents: 5000 });
    expect(RATE_CARD.vehicle).toEqual({ car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 } });
    expect(RATE_CARD.extras['safari-wait']).toBe(1900);
    expect(RATE_CARD.shared.colomboPickupCents).toBe(300);
  });
});
