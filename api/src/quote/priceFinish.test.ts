import { describe, expect, it } from 'vitest';
import { finishPrice } from './priceFinish';

const config = { maxReductionBps: 250, roundToCents: 50 };

// Owner review 2026-08-19. The previous policy was a floor-only $10 grid: it always found *a*
// "…9.00", whether or not that nine sat at a barrier anyone perceives. Measured, it fired on
// 99.9% of quotes over $400 for a mean −$5.00, and produced outcomes the owner rejected as
// "not psychologically attractive" — $438.99 → $429.00, $535.22 → $529.00. At that magnitude
// the nine is the third digit; the reader stops at 4-2.
//
// The replacement aims at thresholds instead of a grid, and only pays when one is in reach.
// The table below is the owner's own worked list, verbatim, and is the contract for this file.
describe('threshold finishing — the owner\'s worked examples', () => {
  it.each([
    // raw     final   note
    [10100, 9999],  // $101 → $99.99, crossing out of three digits
    [10200, 9999],  // $2.01 is still worth the digit-count drop
    [10400, 10400], // $4.01 is not — nothing in reach, left alone
    [8000, 7999],   // a price sitting ON a round number is always shaved
    [5000, 4999],
    [3000, 2999],
    [15200, 14900], // $152 → $149
    [20500, 20500], // $6 to reach $199 is too far
    [100400, 99900], // $1004 → $999
    [101000, 99900], // $11 IS worth it here — 1000 drops a digit
    [102000, 102000], // $21 is not; the ceiling holds
    [155000, 155000], // nearest anchor is $51 away
    [70500, 69900],  // $705 → $699
    [121000, 119900], // $1210 → $1199
    [71000, 71000],  // $11 to reach $699 is NOT worth it — 700 only shifts a leading digit
  ])('finishes %i cents as %i cents', (raw, expected) => {
    expect(finishPrice(raw, 0, config).finalCents).toBe(expected);
  });
});

// The doubling at a power-of-ten anchor is the whole reason $1010 and $710 diverge: both are an
// $11 spend, but only one of them drops a digit off the price. Without it the rule cannot
// reproduce the owner's list at all.
describe('the budget doubles at a power-of-ten anchor', () => {
  it('spends $11 to reach $999 but not to reach $699', () => {
    expect(finishPrice(101000, 0, config).finalCents).toBe(99900);
    expect(finishPrice(71000, 0, config).finalCents).toBe(71000);
  });
});

// Option A, owner's choice 2026-08-19: when no threshold is in reach, drop the cents. Ragged
// cents on a bespoke quote read as an unrounded intermediate; $438.00 reads as a number someone
// arrived at. Always downward, so it can never cost the customer anything.
describe('with no threshold in reach, the cents are floored', () => {
  it.each([
    [43899, 43800], // Q-PDR4F, the quote that started the review: was $429.00 under the old grid
    [53522, 53500],
    [10385, 9999],  // treated as $103.00, which IS in reach of $99.99 — see priceFinish.ts
    [8855, 8800],
    [416070, 416000],
  ])('floors %i cents to %i cents', (raw, expected) => {
    expect(finishPrice(raw, 0, config).finalCents).toBe(expected);
  });

  it('leaves a whole-dollar price with nothing in reach completely alone', () => {
    const r = finishPrice(20500, 0, config);
    expect(r.finalCents).toBe(20500);
    expect(r.strategy).toBe('unchanged');
  });
});

// Real corridors, priced by the live rate card. These are the quotes the owner reviewed the
// policy against, and they pin the two directions the old grid got wrong: prices it moved that
// it should not have, and prices it could not reach at all.
describe('real quote totals', () => {
  it.each([
    [3099, 2999],    // the old grid rounded this UP to $31.00 and missed $29.99 entirely
    [6080, 5999],    // likewise: was $61.00
    [15240, 14900],  // unchanged from the old policy — a threshold genuinely in reach
    [95513, 94900],  // 7-day chauffeur
    [191027, 189900], // 14-day chauffeur: the old grid could only reach $1909
    [286540, 286500], // nothing in reach; keeps the $6.40 the old grid spent
  ])('finishes %i cents as %i cents', (raw, expected) => {
    expect(finishPrice(raw, 0, config).finalCents).toBe(expected);
  });
});

// Owner decision 2026-08-19, stated twice: finishing must never quote ABOVE the engine's number.
// The previous nearest-50c pass could round up (it turned $30.99 into $31.00), and an earlier
// draft of this rule reached UP to thresholds — $1,990 → $1,999 — which was rejected outright.
describe('finishing never raises a price', () => {
  it('holds across the whole realistic quote range, cent by cent', () => {
    // Stepping by a prime so the sweep lands on every cents-remainder class rather than
    // marching in step with the anchor ladder and missing the worst cases.
    for (let raw = 100; raw <= 2_000_000; raw += 97) {
      expect(finishPrice(raw, 0, config).finalCents).toBeLessThanOrEqual(raw);
    }
  });

  it('holds at the anchors themselves, where an off-by-one would round up', () => {
    for (const raw of [3000, 5000, 10000, 15000, 100000, 120000, 500000, 1000000]) {
      expect(finishPrice(raw, 0, config).finalCents).toBeLessThanOrEqual(raw);
    }
  });
});

// The invariant that survived from the old policy, with the cap widened from $10 to $20 — the
// owner-approved budget is 1% of the price, doubled at a power-of-ten anchor, capped at $20.
// The bound below is $20.99: the threshold budget is measured from the cents-floored price, so
// the worst case is the full $20 plus the 99c of cents dropped to get there.
describe('finishing never reduces a price by more than $20 plus its cents', () => {
  const MAX_OFF = 2099;

  it('holds across the whole realistic quote range, cent by cent', () => {
    let worst = { raw: 0, off: 0 };
    for (let raw = 100; raw <= 2_000_000; raw += 97) {
      const off = raw - finishPrice(raw, 0, config).finalCents;
      if (off > worst.off) worst = { raw, off };
    }
    expect(worst.off).toBeLessThanOrEqual(MAX_OFF);
  });

  it('holds at the boundaries where a magnitude-scaled interval would widen', () => {
    for (const raw of [99999, 100000, 100001, 999999, 1000000, 1000001, 9999999, 10000000]) {
      expect(raw - finishPrice(raw, 0, config).finalCents).toBeLessThanOrEqual(MAX_OFF);
    }
  });
});

// A finished price is a fixed point. Without this the fallback eats its own output: $99.99 sits
// one cent under the $100 anchor, so a rule that only looks at the anchor BELOW sees no
// threshold, floors the cents, and destroys the best price on the board.
describe('finishing is idempotent', () => {
  it('never moves a price it has already finished', () => {
    for (let raw = 2900; raw <= 500_000; raw += 97) {
      const once = finishPrice(raw, 0, config).finalCents;
      expect(finishPrice(once, 0, config).finalCents).toBe(once);
    }
  });

  it('recognises a threshold price under the anchor above it', () => {
    for (const raw of [2999, 4999, 7999, 9999, 14900, 69900, 99900, 119900, 189900]) {
      expect(finishPrice(raw, 0, config)).toMatchObject({ finalCents: raw, strategy: 'unchanged' });
    }
  });
});

// Above anything Ceylon Hop actually sells (the largest real quote is a 30-day van14 at ~$4,160)
// there is no threshold worth chasing, so the mechanism stops rather than growing a rung it can
// never exercise.
describe('above $5,000 only the cents are dropped', () => {
  it('does not chase a threshold it would have to pay for', () => {
    expect(finishPrice(1_010_055, 0, config).finalCents).toBe(1_010_000);
    expect(finishPrice(1_250_000, 0, config).finalCents).toBe(1_250_000);
  });
});

// A minimum fare is a FINAL price (rateCard.ts: "no markup — the floor already covers the fixed
// cost of a short trip"), so finishing must not move it. Without this, a $49.99 van floor was
// rounded straight back up to $50.00 — the floor became decorative, and a one-leg quote finished
// at 5000 while a two-leg one totalled 9998 (owner-hit, 2026-08-07).
describe('a price that IS the protected minimum is final', () => {
  it('leaves the floor alone', () => {
    expect(finishPrice(4999, 4999, config)).toEqual({
      rawCents: 4999, finalCents: 4999, adjustmentCents: 0, strategy: 'unchanged',
    });
  });

  it('leaves a multi-leg sum of floors alone too', () => {
    expect(finishPrice(9998, 9998, config).finalCents).toBe(9998);
  });

  it('never finishes below the minimum, by either strategy', () => {
    expect(finishPrice(15200, 15000, config).finalCents).toBeGreaterThanOrEqual(15000);
    expect(finishPrice(10050, 10040, config).finalCents).toBeGreaterThanOrEqual(10040);
  });
});

describe('input validation', () => {
  it('rejects invalid, non-integer money inputs', () => {
    expect(() => finishPrice(8099.5, 0, config)).toThrow('INVALID_PRICE');
    expect(() => finishPrice(-1, 0, config)).toThrow('INVALID_PRICE');
  });

  it('rejects a malformed finishing config', () => {
    expect(() => finishPrice(8099, 0, { maxReductionBps: -1, roundToCents: 50 }))
      .toThrow('INVALID_PRICE_FINISHING_CONFIG');
    expect(() => finishPrice(8099, 0, { maxReductionBps: 250, roundToCents: 0 }))
      .toThrow('INVALID_PRICE_FINISHING_CONFIG');
  });

  it('leaves a zero price alone', () => {
    expect(finishPrice(0, 0, config).finalCents).toBe(0);
  });
});
