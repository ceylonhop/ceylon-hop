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

function reductionWithinLimit(rawCents: number, candidateCents: number, maxReductionBps: number): boolean {
  if (candidateCents >= rawCents) return true;
  return (rawCents - candidateCents) * 10_000 <= rawCents * maxReductionBps;
}

function charmCandidate(rawCents: number): number {
  const wholeDollars = Math.floor(rawCents / 100);
  const digits = Math.max(1, String(wholeDollars).length);
  const intervalDollars = digits <= 3 ? 10 : 10 ** (digits - 2);
  const intervalCents = intervalDollars * 100;
  return Math.floor((rawCents + 100) / intervalCents) * intervalCents - 100;
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
