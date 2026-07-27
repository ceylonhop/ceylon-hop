export type PriceFinishStrategy = 'charm' | 'nearest_50_cents' | 'unchanged';

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

function unchanged(rawCents: number): FinishedPrice {
  return { rawCents, finalCents: rawCents, adjustmentCents: 0, strategy: 'unchanged' };
}

// A downward finish must clear BOTH limits: the proportional one (maxReductionBps, which does the
// protecting on small totals) and the absolute one (MAX_REDUCTION_CENTS, which does it on large
// ones, where a percentage stops being a meaningful bound).
function reductionWithinLimit(rawCents: number, candidateCents: number, maxReductionBps: number): boolean {
  if (candidateCents >= rawCents) return true;
  const off = rawCents - candidateCents;
  if (off > MAX_REDUCTION_CENTS) return false;
  return off * 10_000 <= rawCents * maxReductionBps;
}

// Finishing is a cosmetic tidy-up of the last digits, so it may never hand back real money.
// Owner rule (2026-07-26): round to the nearest $10 and never give away more than $10.
const CHARM_INTERVAL_CENTS = 1000; // $10 — the charm target is the "…9.00" below this grid
const MAX_REDUCTION_CENTS = 1000; // $10 — an absolute floor under any downward finish

// The "…9.00" price at or below rawCents on a $10 grid: $184.27 → $179.00, $1,842.77 → $1,839.00.
//
// The interval used to WIDEN with the number's magnitude ($100 at four digits, $1,000 at five),
// which is how a $1,842.77 chauffeur quote finished at $1,799.00 — a $43.77 giveaway that the
// 2.5% bps cap waved through, because 2.5% of a big number is a lot of money. A fixed $10 grid
// bounds the reduction by construction, and MAX_REDUCTION_CENTS below enforces it regardless.
function charmCandidate(rawCents: number): number {
  return Math.floor((rawCents + 100) / CHARM_INTERVAL_CENTS) * CHARM_INTERVAL_CENTS - 100;
}

function nearestIncrement(rawCents: number, incrementCents: number): number {
  const lower = Math.floor(rawCents / incrementCents) * incrementCents;
  const upper = lower + incrementCents;
  return rawCents - lower <= upper - rawCents ? lower : upper;
}

// Final-price policy only. Core fares, buffers, floors, extras and day charges have already
// produced rawCents before this runs. minimumAllowedCents prevents a downward finish from
// crossing the engine's modelled cost basis; upward rounding is capped by the increment.
export function finishPrice(
  rawCents: number,
  minimumAllowedCents: number,
  config: PriceFinishingConfig,
): FinishedPrice {
  if (!Number.isInteger(rawCents) || rawCents < 0 || !Number.isInteger(minimumAllowedCents) || minimumAllowedCents < 0) {
    throw new Error('INVALID_PRICE');
  }
  if (!Number.isInteger(config.maxReductionBps) || config.maxReductionBps < 0 ||
      !Number.isInteger(config.roundToCents) || config.roundToCents <= 0) {
    throw new Error('INVALID_PRICE_FINISHING_CONFIG');
  }
  if (rawCents === 0) return unchanged(rawCents);

  const charm = charmCandidate(rawCents);
  if (charm === rawCents) return unchanged(rawCents);
  if (charm > 0 && charm < rawCents && charm >= minimumAllowedCents &&
      reductionWithinLimit(rawCents, charm, config.maxReductionBps)) {
    return { rawCents, finalCents: charm, adjustmentCents: charm - rawCents, strategy: 'charm' };
  }

  const rounded = nearestIncrement(rawCents, config.roundToCents);
  if (rounded === rawCents || rounded < minimumAllowedCents ||
      !reductionWithinLimit(rawCents, rounded, config.maxReductionBps)) {
    return unchanged(rawCents);
  }
  return {
    rawCents,
    finalCents: rounded,
    adjustmentCents: rounded - rawCents,
    strategy: 'nearest_50_cents',
  };
}
