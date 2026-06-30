import { describe, it, expect } from 'vitest';
import { legPriceCents, quotePrivateLegs } from './private';

describe('legPriceCents', () => {
  it('prices per km (Tatia Kandy→Nanu Oya 80km car = $36.80)', () => {
    expect(legPriceCents(80, 'car')).toBe(3680);
  });
  it('applies the $29 car floor on short legs (35km → $29)', () => {
    expect(legPriceCents(35, 'car')).toBe(2900);
  });
  it('applies the $50 van floor (40km van = 3320 → floored to 5000)', () => {
    expect(legPriceCents(40, 'van')).toBe(5000);
  });
  it('van per-km above the floor (200km van = $166)', () => {
    expect(legPriceCents(200, 'van')).toBe(16600);
  });
});

describe('quotePrivateLegs', () => {
  it('sums legs and warns on floored legs (Julián Mirissa→Tangalle + Yala→Tangalle)', () => {
    const r = quotePrivateLegs(
      [
        { from: 'Mirissa', to: 'Tangalle', distanceKm: 35 }, // → floor $29
        { from: 'Yala', to: 'Tangalle', distanceKm: 75 },    // → $34.50
      ],
      'car',
    );
    expect(r.subtotalCents).toBe(2900 + 3450);
    expect(r.lineItems).toHaveLength(2);
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  });
});
