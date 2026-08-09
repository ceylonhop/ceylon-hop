// api/src/quote/discount.test.ts
// Task 2 of docs/superpowers/plans/2026-08-09-founder-manual-discounts.md.
//
// Unlike goldens.test.ts — which SNAPSHOTS what the engine already does — every expectation here
// is a hand-computed constant asserting what the rule SHOULD do (spec §5.2).
//
// The second argument is the FINISHED total — the price the customer was quoted. Finishing runs
// BEFORE the discount (owner, 2026-08-09) so a founder negotiates off the number that was sent,
// and quoted − discount === charged exactly. The arithmetic is
// written out in each case so a reviewer can check it without running anything.
import { describe, it, expect } from 'vitest';
import { resolveDiscount, MAX_DISCOUNT_PCT } from './discount';

const REASON = 'closing the Perera booking';
const fixed = (amountCents: number) => ({ source: 'manual' as const, method: 'fixed' as const, amountCents, reason: REASON });
const pct = (basisPoints: number) => ({ source: 'manual' as const, method: 'percentage' as const, basisPoints, reason: REASON });

describe('resolveDiscount() — the whole rule is two limits', () => {
  it('applies a fixed amount in full when neither limit binds', () => {
    // subtotal $200.00, one car leg → floor $29.00. 30% cap = $60.00, headroom = $171.00.
    const r = resolveDiscount(fixed(1000), 20000, 2900);
    expect(r.appliedCents).toBe(1000);
    expect(r.requestedCents).toBe(1000);
    expect(r.capReason).toBeNull();
  });

  it('computes a percentage with round-half-up', () => {
    // 10% of $103.85 = 1038.5¢ → half-up → 1039¢.
    expect(resolveDiscount(pct(1000), 10385, 2900).appliedCents).toBe(1039);
    // 10% of $103.84 = 1038.4¢ → 1038¢.
    expect(resolveDiscount(pct(1000), 10384, 2900).appliedCents).toBe(1038);
  });

  it('caps at 30% of the subtotal', () => {
    // $200.00 subtotal. Founder asks $80.00; 30% = $60.00 wins.
    const r = resolveDiscount(fixed(8000), 20000, 2900);
    expect(r.requestedCents).toBe(8000);
    expect(r.appliedCents).toBe(6000);
    expect(r.capReason).toBe('percentage_cap');
  });

  it('caps a percentage request at 30% too', () => {
    // A 50% request is still only worth 30%.
    expect(resolveDiscount(pct(5000), 20000, 2900).appliedCents).toBe(6000);
  });

  it('binds exactly at the 30% boundary without tripping the cap', () => {
    // 30% of $200.00 is exactly $60.00 — allowed in full, nothing bound.
    const r = resolveDiscount(fixed(6000), 20000, 2900);
    expect(r.appliedCents).toBe(6000);
    expect(r.capReason).toBeNull();
  });

  it('never lets the subtotal fall below the vehicle minimum', () => {
    // A $35.00 van quote. Floor $49.99 is ABOVE it → headroom 0 → no discount possible.
    const r = resolveDiscount(fixed(500), 3500, 4999);
    expect(r.appliedCents).toBe(0);
    expect(r.capReason).toBe('vehicle_minimum');
  });

  it('allows exactly down to the floor and not a cent further', () => {
    // $60.00 van quote, floor $49.99 → headroom $10.01. 30% would allow $18.00, so the floor wins.
    const r = resolveDiscount(fixed(1500), 6000, 4999);
    expect(r.appliedCents).toBe(1001);
    expect(6000 - r.appliedCents).toBe(4999);
    expect(r.capReason).toBe('vehicle_minimum');
  });

  it('takes the smaller of the two when both would bind', () => {
    // $100.00 car quote, floor $29.00 → headroom $71.00; 30% cap = $30.00. Cap is smaller.
    const r = resolveDiscount(fixed(9000), 10000, 2900);
    expect(r.appliedCents).toBe(3000);
    expect(r.capReason).toBe('percentage_cap');
  });

  it('counts one driver minimum PER LEG', () => {
    // Three car legs → 3 × $29.00 = $87.00 protected. $100.00 subtotal → headroom $13.00,
    // which beats the 30% cap of $30.00.
    const r = resolveDiscount(fixed(3000), 10000, 8700);
    expect(r.appliedCents).toBe(1300);
    expect(r.capReason).toBe('vehicle_minimum');
  });

  it('bounds chauffeur by the percentage alone, since it has no floor', () => {
    // protectedMinimumCents is 0 for chauffeur (engine.ts:58 sets it only on the private branch).
    const r = resolveDiscount(fixed(100000), 200000, 0);
    expect(r.appliedCents).toBe(60000);
    expect(r.capReason).toBe('percentage_cap');
  });

  it('reports vehicle_minimum when the two limits tie', () => {
    // $100.00 subtotal, floor $70.00 → headroom $30.00, exactly the 30% cap. The floor is the
    // money-losing constraint, so it is the one named.
    expect(resolveDiscount(fixed(9000), 10000, 7000).capReason).toBe('vehicle_minimum');
  });

  it('returns zero rather than a negative discount', () => {
    expect(resolveDiscount(fixed(0), 20000, 2900).appliedCents).toBe(0);
    expect(resolveDiscount(pct(0), 20000, 2900).appliedCents).toBe(0);
  });

  it('can never remove the whole subtotal, because 30% always binds first', () => {
    const r = resolveDiscount(fixed(999999), 10000, 0);
    expect(r.appliedCents).toBe(3000);
    expect(10000 - r.appliedCents).toBeGreaterThan(0);
  });

  it('echoes the request back for the audit row', () => {
    const r = resolveDiscount(pct(1500), 20000, 2900);
    expect(r.method).toBe('percentage');
    expect(r.value).toBe(1500);
    expect(r.quotedTotalCents).toBe(20000);
  });

  it('rejects malformed input rather than pricing it', () => {
    expect(() => resolveDiscount(fixed(-1), 20000, 2900)).toThrow('INVALID_DISCOUNT');
    expect(() => resolveDiscount(fixed(1.5), 20000, 2900)).toThrow('INVALID_DISCOUNT');
    expect(() => resolveDiscount({ ...fixed(100), reason: '  ' }, 20000, 2900)).toThrow('INVALID_DISCOUNT');
    expect(() => resolveDiscount(fixed(100), -1, 2900)).toThrow('INVALID_DISCOUNT');
  });

  it('pins the ceiling at 30 percent', () => {
    expect(MAX_DISCOUNT_PCT).toBe(30);
  });
});
