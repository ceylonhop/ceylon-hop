import { describe, it, expect } from 'vitest';
import { billableKm, legPriceCents, quotePrivateLegs } from './private';

describe('legPriceCents', () => {
  it('prices per km (Tatia Kandy→Nanu Oya 80km car → $32.20, above $29 floor)', () => {
    expect(legPriceCents(80, 'car')).toBe(3220); // round(80 × 40.25) = 3220 > 2900 floor
  });
  it('applies the $29 car floor on short legs (35km → $29)', () => {
    expect(legPriceCents(35, 'car')).toBe(2900);
  });
  it('applies the $50 van floor (40km van = 1880 → floored to 5000)', () => {
    expect(legPriceCents(40, 'van')).toBe(5000);
  });
  it('van per-km above the floor (200km van = $108.10)', () => {
    expect(legPriceCents(200, 'van')).toBe(10810); // round(200 × 54.05) = 10810
  });
});

describe('billableKm', () => {
  it('adds 10% (half-up)', () => {
    expect(billableKm(80)).toBe(88);
    expect(billableKm(75)).toBe(83);   // 82.5 → 83
    expect(billableKm(35)).toBe(39);   // 38.5 → 39
  });
});

describe('quotePrivateLegs', () => {
  it('prices off buffered km (Julián subtotal 6241)', () => {
    const r = quotePrivateLegs(
      [
        { from: 'Mirissa', to: 'Tangalle', distanceKm: 35 }, // bill 39 → $29 floor
        { from: 'Yala', to: 'Tangalle', distanceKm: 75 },    // bill 83 → 83×40.25 = 3341
      ],
      'car',
    );
    expect(r.subtotalCents).toBe(6241); // 2900 floor + 3341
    expect(r.lineItems).toHaveLength(2);
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  });
});
