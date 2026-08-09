import { describe, expect, it } from 'vitest';
import { finishPrice } from './priceFinish';

const config = { maxReductionBps: 250, roundToCents: 50 };

describe('finishPrice', () => {
  it.each([
    [8099, 7900, 'charm'],
    [40148, 39900, 'charm'],
    // Owner, 2026-07-26: the charm interval used to WIDEN with the number's magnitude ($100 at
    // four digits, $1,000 at five), so a $1,842.77 chauffeur quote fell to $1,799.00 — $43.77 of
    // margin given away by a rounding rule. The interval is now $10 at every size.
    [102000, 101900, 'charm'],
    [112500, 111900, 'charm'],
    [152000, 151900, 'charm'],
    [204500, 203900, 'charm'],
    [184277, 183900, 'charm'], // the reported quote: -$3.77, not -$43.77
  ] as const)('finishes %i cents as %i cents using %s', (raw, expected, strategy) => {
    expect(finishPrice(raw, 0, config)).toEqual({
      rawCents: raw,
      finalCents: expected,
      adjustmentCents: expected - raw,
      strategy,
    });
  });

  // The charm target is rejected when its drop breaks the 2.5% cap, which now only happens on
  // SMALL totals — at four figures a $10 grid never costs more than 2.5%. (The two large rows
  // that used to live here, 112936 and 206018, now finish as charm for −$0.36 and −$1.18; under
  // the old widening interval they were skipped only because the drop was enormous.)
  it.each([
    [8110, 8100],  // charm 7900 is −$2.10 on $81.10 = 2.59% → rejected, rounds down to the 50c
    [3020, 3000],  // charm 2900 is −$1.20 on $30.20 = 3.97% → rejected
    [5080, 5100],  // charm 4900 is −$1.80 on $50.80 = 3.54% → rejected, and 50c rounds UP
  ])('falls back from an ineligible charm target and rounds %i cents to %i cents', (raw, expected) => {
    expect(finishPrice(raw, 0, config)).toMatchObject({
      finalCents: expected,
      adjustmentCents: expected - raw,
      strategy: 'nearest_50_cents',
    });
  });

  it('accepts an exact 2.5% reduction and rejects one above 2.5%', () => {
    expect(finishPrice(4000, 0, config).finalCents).toBe(3900);
    expect(finishPrice(8110, 0, config).finalCents).toBe(8100);
  });

  it('rounds an exact 25-cent tie down in the customer\'s favour', () => {
    expect(finishPrice(8125, 0, config).finalCents).toBe(8100);
  });

  it('leaves a price already on a charm target unchanged', () => {
    expect(finishPrice(39900, 0, config)).toEqual({
      rawCents: 39900,
      finalCents: 39900,
      adjustmentCents: 0,
      strategy: 'unchanged',
    });
  });

  it('rejects a downward adjustment below the minimum allowed price', () => {
    expect(finishPrice(40148, 40000, config).finalCents).toBe(40150);
    expect(finishPrice(8110, 8105, config).finalCents).toBe(8110);
  });

  it('rejects invalid, non-integer money inputs', () => {
    expect(() => finishPrice(8099.5, 0, config)).toThrow('INVALID_PRICE');
    expect(() => finishPrice(-1, 0, config)).toThrow('INVALID_PRICE');
  });
});

// The owner's rule, stated as an invariant rather than a table: finishing is a cosmetic tidy-up,
// so it may never hand back real money. It exists because the previous magnitude-scaled interval
// broke it silently and only at large totals — the sizes least often eyeballed in a test.
describe('finishing never reduces a price by more than $10', () => {
  const MAX_OFF = 1000; // cents

  it('holds across the whole realistic quote range, cent by cent', () => {
    // $1 → $20,000, stepping by a prime so the sweep lands on every cents-remainder class
    // rather than marching in step with the $10 interval and missing the worst cases.
    let worst = { raw: 0, off: 0 };
    for (let raw = 100; raw <= 2_000_000; raw += 97) {
      const off = raw - finishPrice(raw, 0, config).finalCents;
      if (off > worst.off) worst = { raw, off };
    }
    expect(worst.off).toBeLessThanOrEqual(MAX_OFF);
  });

  it('holds at the boundaries where the old interval used to widen', () => {
    // 3→4 and 4→5 digits: $999.99 / $1,000.00 / $9,999.99 / $10,000.00 and their neighbours.
    for (const raw of [99999, 100000, 100001, 999999, 1000000, 1000001, 9999999, 10000000]) {
      expect(raw - finishPrice(raw, 0, config).finalCents).toBeLessThanOrEqual(MAX_OFF);
    }
  });

  it('never rounds a price UP by more than the 50c increment either', () => {
    for (let raw = 100; raw <= 500_000; raw += 97) {
      expect(finishPrice(raw, 0, config).finalCents - raw).toBeLessThanOrEqual(50);
    }
  });

  it('is enforced by the function, not just by the current interval', () => {
    // A guard inside finishPrice must reject an over-large charm drop even if the interval is
    // later widened again — otherwise this invariant lives only in charmCandidate's arithmetic.
    // 25% of bps head-room, so only the absolute cap can be what stops a big reduction.
    const loose = { maxReductionBps: 2500, roundToCents: 50 };
    for (let raw = 100; raw <= 2_000_000; raw += 997) {
      expect(raw - finishPrice(raw, 0, loose).finalCents).toBeLessThanOrEqual(MAX_OFF);
    }
  });
});

// A minimum fare is a FINAL price (rateCard.ts: "no markup — the floor already covers the fixed
// cost of a short trip"), so finishing must not move it. Without this, a $49.99 van floor was
// rounded straight back up to $50.00 by the nearest-50¢ pass — the floor became decorative, and
// a one-leg quote finished at 5000 while a two-leg one totalled 9998, so the same minimum showed
// two different prices depending on leg count (owner-hit, 2026-08-07).
describe('a price that IS the protected minimum is final', () => {
  it('leaves the floor alone rather than rounding it up', () => {
    const r = finishPrice(4999, 4999, { maxReductionBps: 250, roundToCents: 50 });
    expect(r.finalCents).toBe(4999);
    expect(r.adjustmentCents).toBe(0);
    expect(r.strategy).toBe('unchanged');
  });

  it('leaves a multi-leg sum of floors alone too', () => {
    const r = finishPrice(9998, 9998, { maxReductionBps: 250, roundToCents: 50 });
    expect(r.finalCents).toBe(9998);
  });

  it('still finishes a price that merely sits above the minimum', () => {
    const r = finishPrice(10_040, 4999, { maxReductionBps: 250, roundToCents: 50 });
    expect(r.finalCents).toBeLessThan(10_040);
  });
});
