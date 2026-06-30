import { describe, it, expect } from 'vitest';
import { priceExtras, depositCents } from './extrasDeposit';

describe('priceExtras', () => {
  it('sums known extras (sightseeing $10 + safari-wait $19 = $29)', () => {
    const r = priceExtras(['sightseeing', 'safari-wait']);
    expect(r.subtotalCents).toBe(2900);
    expect(r.lineItems).toHaveLength(2);
  });
  it('prices waiting extra ($10)', () => {
    expect(priceExtras(['waiting']).subtotalCents).toBe(1000);
  });
  it('throws on an unknown extra code', () => {
    // @ts-expect-error invalid code on purpose
    expect(() => priceExtras(['bogus'])).toThrow('UNKNOWN_EXTRA');
  });
});

describe('depositCents', () => {
  it('10% under the cap ($400 → $40)', () => {
    expect(depositCents(40000)).toBe(4000);
  });
  it('caps at $50 ($867 → $50, not $86.70)', () => {
    expect(depositCents(86700)).toBe(5000);
  });
});
