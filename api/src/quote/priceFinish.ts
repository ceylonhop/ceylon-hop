export type PriceFinishStrategy = 'threshold' | 'floor_cents' | 'unchanged';

export interface PriceFinishingConfig {
  maxReductionBps: number;
  roundToCents: number;
}

export interface FinishedPrice {
  rawCents: number;
  finalCents: number;
  adjustmentCents: number;
  strategy: PriceFinishStrategy;
}

// Owner review 2026-08-19. Finishing aims at a THRESHOLD — the price just under a barrier the
// customer actually perceives — and pays only when one is close enough to be worth reaching.
//
// The policy it replaced was a floor-only $10 grid. It always found a "…9.00", but at four
// figures that nine is the third digit and nobody reads it: $438.99 finished at $429.00, a $9.99
// spend to move a digit below the threshold of attention, and it stepped straight over $439.00
// to get there. Measured over $400 it fired on 99.9% of quotes for a mean of −$5.00.
//
// Widening the grid with magnitude is NOT the fix and must not be reintroduced — that was the
// original design, and it finished a $1,842.77 chauffeur quote at $1,799.00, a $43.77 giveaway.
// The budget below is what bounds the spend; the ladder only decides where the barriers are.

// The barriers get coarser as the number grows, because so does the granularity anyone reads.
const LADDER = [
  { below: 10_000, step: 1_000 },   // under $100 → every $10  ($30, $50, $80)
  { below: 100_000, step: 5_000 },  // under $1,000 → every $50 ($100, $150, $700)
] as const;
const COARSEST_STEP = 10_000;       // $1,000 and up → every $100

// The nine moves as the price grows: it sits in the cents up to $100 ($49.99) and in the dollars
// above it ($149, $699, $1,199), where trailing cents are noise on a bespoke quote.
const CENTS_ANCHOR_LIMIT = 10_000;

const DOWN_BPS = 100;               // 1% of the price...
const POW10_MULTIPLIER = 2;         // ...doubled when the barrier drops a digit off the price
const MIN_DOWN_CENTS = 350;         // small totals need an absolute floor; 1% of $30 buys nothing
const MAX_DOWN_CENTS = 2000;        // and large ones need an absolute ceiling

// The largest real quote is a 30-day van14 at ~$4,160. Above this there is no barrier worth
// chasing, so the mechanism stops rather than growing a rung it can never exercise.
const THRESHOLD_CEILING_CENTS = 500_000;

function stepFor(cents: number): number {
  return LADDER.find((rung) => cents < rung.below)?.step ?? COARSEST_STEP;
}

function targetFor(anchorCents: number): number {
  return anchorCents <= CENTS_ANCHOR_LIMIT ? anchorCents - 1 : anchorCents - 100;
}

// 1000 → true, 1500 → false. A barrier that removes a digit ($100 → $99.99, $1,000 → $999) is
// the strongest effect in charm pricing and earns twice the budget; one that merely shifts a
// leading digit ($700 → $699) does not. This is exactly what separates the owner's $1,010 → $999
// (worth $11) from $710 → $710 (not worth $11) — the same spend, a different prize.
function isPowerOfTen(cents: number): boolean {
  let n = cents;
  while (n >= 10 && n % 10 === 0) n /= 10;
  return n === 1;
}

function budgetFor(rawCents: number, anchorCents: number): number {
  const pct = Math.round((rawCents * DOWN_BPS) / 10_000) * (isPowerOfTen(anchorCents) ? POW10_MULTIPLIER : 1);
  return Math.min(Math.max(pct, MIN_DOWN_CENTS), MAX_DOWN_CENTS);
}

// A finished price must be a fixed point, and $99.99 is the case that proves it: it sits one cent
// under the $100 anchor, so a rule that only looks at the anchor BELOW sees no threshold nearby,
// falls through to dropping the cents, and destroys the best price on the board.
function isThresholdPrice(cents: number): boolean {
  const step = stepFor(cents);
  const anchorBelow = Math.floor(cents / step) * step;
  return cents === targetFor(anchorBelow) || cents === targetFor(anchorBelow + step);
}

function unchanged(rawCents: number): FinishedPrice {
  return { rawCents, finalCents: rawCents, adjustmentCents: 0, strategy: 'unchanged' };
}

// Final-price policy only. Core fares, buffers, floors, extras and day charges have already
// produced rawCents before this runs. minimumAllowedCents prevents a downward finish from
// crossing the engine's modelled cost basis.
//
// Owner decision 2026-08-19, stated twice: this may never quote ABOVE the engine's number. Both
// strategies below are strictly downward, and a sweep in the tests holds the whole range to it.
export function finishPrice(
  rawCents: number,
  minimumAllowedCents: number,
  config: PriceFinishingConfig,
): FinishedPrice {
  if (!Number.isInteger(rawCents) || rawCents < 0 || !Number.isInteger(minimumAllowedCents) || minimumAllowedCents < 0) {
    throw new Error('INVALID_PRICE');
  }
  // The two legacy fields no longer carry the policy — the constants above do — but they still
  // gate whether finishing runs at all (engine.ts checks `rateCard.priceFinishing`), and locked
  // quotes hold rate-card snapshots containing them, so the shape is validated and kept.
  if (!Number.isInteger(config.maxReductionBps) || config.maxReductionBps < 0 ||
      !Number.isInteger(config.roundToCents) || config.roundToCents <= 0) {
    throw new Error('INVALID_PRICE_FINISHING_CONFIG');
  }
  if (rawCents === 0) return unchanged(rawCents);
  // A price that IS the protected minimum is already final: rateCard.ts states a floor is "a
  // FINAL price with NO markup", so a $49.99 van floor must not be tidied into $49.00.
  if (rawCents === minimumAllowedCents) return unchanged(rawCents);
  if (isThresholdPrice(rawCents)) return unchanged(rawCents);

  // Drop the cents FIRST and decide everything from that number. Deciding from rawCents instead
  // makes the rule non-idempotent: $33.85 is out of budget for $29.99 and falls back to $33.00,
  // which IS in budget, so a second pass moves it again. Whatever we do to $33.00 we must do to
  // $33.85. (Owner's choice 2026-08-19 was to drop the cents, so the floored price is the honest
  // basis; the visible consequence is that $103.85 is treated as $103.00 and reaches $99.99.)
  const floored = Math.floor(rawCents / 100) * 100;
  const base = floored >= minimumAllowedCents ? floored : rawCents;

  if (base <= THRESHOLD_CEILING_CENTS) {
    const step = stepFor(base);
    const anchor = Math.floor(base / step) * step;
    const target = targetFor(anchor);
    // Everything is measured from `base`. Guarding on rawCents instead breaks idempotency again
    // (a price rejected for being 99c over the cap falls back to exactly the price that passes),
    // so the total giveaway is the budget plus at most the 99c of cents — bounded, and asserted.
    if (target >= minimumAllowedCents && target < base && base - target <= budgetFor(base, anchor)) {
      return { rawCents, finalCents: target, adjustmentCents: target - rawCents, strategy: 'threshold' };
    }
  }

  if (base < rawCents) {
    return { rawCents, finalCents: base, adjustmentCents: base - rawCents, strategy: 'floor_cents' };
  }
  return unchanged(rawCents);
}
