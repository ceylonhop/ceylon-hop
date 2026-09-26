import { describe, it, expect } from 'vitest';
import { buildPricingPayload } from './pricingPayload';
import { RATE_CARD } from './rateCard';

describe('buildPricingPayload', () => {
  it('builds from a given card — the live one for GET /quote/pricing', () => {
    const card = { ...RATE_CARD, perKmCents: { ...RATE_CARD.perKmCents, car: 45 }, extras: { ...RATE_CARD.extras, waiting: 1200 } };
    const p = buildPricingPayload(card);
    expect(p.perKm.car).toBe(0.45);
    expect(p.extras.waiting).toBe(12);
    expect(p.seatPricing.perKmCentsVan).toBe(RATE_CARD.perKmCents.van);
  });

  it('converts the rate card to whole-USD front-end values', () => {
    const p = buildPricingPayload();
    expect(p.perKm).toEqual({ car: 0.4025, van: 0.5405 });
    expect(p.floors).toEqual({ car: 29, van: 49.99 });
    expect(p.bufferPct).toBe(10);
    expect(p.priceFinishing).toEqual({ maxReductionBps: 250, roundToCents: 50 });
    expect(p.chauffeurDayFee).toBe(31.05);
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
