import { describe, it, expect } from 'vitest';
import { buildPricingPayload } from './pricingPayload';

describe('buildPricingPayload', () => {
  it('converts the rate card to whole-USD front-end values', () => {
    const p = buildPricingPayload();
    expect(p.perKm).toEqual({ car: 0.35, van: 0.47 });
    expect(p.floors).toEqual({ car: 29, van: 50 });
    expect(p.bufferPct).toBe(10);
    expect(p.chauffeurDayFee).toBe(35);
    expect(p.depositPct).toBe(0.1);
    expect(p.depositCap).toBe(50);
    expect(p.extras).toMatchObject({
      sightseeing: 10,
      'safari-wait': 19,
      luggage: 5,
      front: 8,
      flex: 12,
      waiting: 10,
    });
    expect(p.corridorSeat).toMatchObject({
      'airport-cultural': 19,
      'hill-line': 21,
      'ella-east': 23,
      'south-coast': 14,
      'yala-south': 16,
      'ella-south': 24,
    });
  });
});
