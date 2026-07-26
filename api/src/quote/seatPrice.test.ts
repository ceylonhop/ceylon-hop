import { describe, it, expect } from 'vitest';
import { seatPriceForDistance, SEATS_COVERING_VAN } from './seatPrice';
import { RATE_CARD } from './rateCard';

describe('ride-board seat price', () => {
  it('is the van fare for the distance, split three ways', () => {
    const km = 113; // Colombo Airport → Kandy
    const vanFare = Math.round(km * RATE_CARD.perKmCents.van);
    expect(vanFare).toBeGreaterThan(RATE_CARD.floorCents.van); // not floored at this distance
    expect(seatPriceForDistance(km)).toBe(2050); // $61.08 van → $20.36 → $20.50
  });

  it('rounds to the nearest 50c, both directions', () => {
    // 89 km → $50.00 van (floored) → $16.67 → rounds DOWN to $16.50
    expect(seatPriceForDistance(89)).toBe(1650);
    // 164 km → $88.64 van → $29.55 → rounds DOWN to $29.50
    expect(seatPriceForDistance(164)).toBe(2950);
    // 118 km → $63.78 van → $21.26 → rounds UP to $21.50
    expect(seatPriceForDistance(118)).toBe(2150);
    for (const km of [12, 38, 75, 140, 201, 300]) {
      expect(seatPriceForDistance(km) % 50).toBe(0);
    }
  });

  it('never prices below the van floor split three ways — a short hop still costs a van', () => {
    const floorSeat = Math.round(RATE_CARD.floorCents.van / SEATS_COVERING_VAN / 50) * 50;
    for (const km of [1, 5, 20, 38]) {
      expect(seatPriceForDistance(km)).toBe(floorSeat);
    }
  });

  it('three seats cover the van, and six roughly double it', () => {
    const km = 201;
    const vanFare = Math.max(Math.round(km * RATE_CARD.perKmCents.van), RATE_CARD.floorCents.van);
    const seat = seatPriceForDistance(km);
    // Three seats cover the van to within rounding: each seat is rounded to the nearest 50c, so
    // the three-seat total can sit up to 75c either side of the van fare. Immaterial in money
    // terms, but it means "three seats cover the van" is exact-ish, not exact.
    expect(Math.abs(seat * 3 - vanFare)).toBeLessThanOrEqual(75);
    // The back three seats are the margin.
    expect(seat * 6).toBeGreaterThan(vanFare * 1.9);
  });

  it('grows with distance', () => {
    expect(seatPriceForDistance(200)).toBeGreaterThan(seatPriceForDistance(100));
    expect(seatPriceForDistance(100)).toBeGreaterThan(seatPriceForDistance(60));
  });

  it('refuses a distance it cannot price', () => {
    for (const bad of [0, -5, NaN, Infinity]) {
      expect(() => seatPriceForDistance(bad)).toThrow(/positive number/);
    }
  });
});
