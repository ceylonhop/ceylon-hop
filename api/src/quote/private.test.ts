import { describe, it, expect } from 'vitest';
import { billableKm, legPriceCents, quotePrivateLegs } from './private';

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

describe('billableKm', () => {
  it('adds 10% (half-up)', () => {
    expect(billableKm(80)).toBe(88);
    expect(billableKm(75)).toBe(83);   // 82.5 → 83
    expect(billableKm(35)).toBe(39);   // 38.5 → 39
  });
});

describe('quotePrivateLegs', () => {
  it('prices off buffered km (Julián subtotal 6718)', () => {
    const r = quotePrivateLegs(
      [
        { from: 'Mirissa', to: 'Tangalle', distanceKm: 35 }, // bill 39 → $29 floor
        { from: 'Yala', to: 'Tangalle', distanceKm: 75 },    // bill 83 → 83×46 = 3818
      ],
      'car',
    );
    expect(r.subtotalCents).toBe(6718);
    expect(r.lineItems).toHaveLength(2);
    expect(r.warnings).toContain('Mirissa→Tangalle hit the $29 car minimum');
  });
});
