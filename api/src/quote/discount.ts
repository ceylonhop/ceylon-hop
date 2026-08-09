// api/src/quote/discount.ts
// Founder manual discounts — the arithmetic, and nothing else.
// Design: docs/superpowers/specs/2026-08-09-founder-manual-discounts-design.md §5.2.
//
// Pure: no database, no authorization, no clock. The caller resolves WHO may discount and
// persists the outcome; this module only decides how many cents come off.
//
// The rule is deliberately two limits and no cost model. Cost was tried and rejected by the
// owner (2026-08-09): a per-km cost estimate understates a short trip badly, because a Sri Lankan
// driver charges a fixed minimum to take a job at all rather than charging by distance. Roughly
// $20-23 of a car's $29 minimum and about $40.43 of a van's $49.99 goes to the driver, so the
// FARE FLOOR — not the modelled cost — is what actually protects the margin. See §5.3.

export type DiscountMethod = 'fixed' | 'percentage';

/** What a founder asks for. Clients submit this; they never submit applied cents. */
export type DiscountRequest =
  | { source: 'manual'; method: 'fixed'; amountCents: number; reason: string }
  | { source: 'manual'; method: 'percentage'; basisPoints: number; reason: string };

/** Which limit reduced the request, when one did. */
export type DiscountCapReason = 'percentage_cap' | 'vehicle_minimum';

export interface ResolvedDiscount {
  method: DiscountMethod;
  /** Cents for `fixed`, basis points for `percentage` — the founder's input, kept for the audit row. */
  value: number;
  reason: string;
  /** The gross subtotal this was resolved against. */
  subtotalCents: number;
  /** What the founder asked for, before either limit. */
  requestedCents: number;
  /** What actually comes off. Always `0 <= appliedCents <= requestedCents`. */
  appliedCents: number;
  capReason: DiscountCapReason | null;
}

/** A discount may never exceed this share of the subtotal. Owner, 2026-08-09. */
export const MAX_DISCOUNT_PCT = 30;

function assertCents(n: number): void {
  if (!Number.isSafeInteger(n) || n < 0) throw new Error('INVALID_DISCOUNT');
}

/**
 * Resolve a founder's request against the two limits.
 *
 * `protectedMinimumCents` is the engine's own `rides.length * rateCard.floorCents[vehicle]`
 * (engine.ts:58) — one driver minimum per leg, so a three-leg car day protects 3 × $29.00. It is
 * `0` for chauffeur, which correctly leaves chauffeur bounded by the percentage alone.
 */
export function resolveDiscount(
  req: DiscountRequest,
  subtotalCents: number,
  protectedMinimumCents: number,
): ResolvedDiscount {
  assertCents(subtotalCents);
  assertCents(protectedMinimumCents);
  if (typeof req.reason !== 'string' || req.reason.trim() === '') throw new Error('INVALID_DISCOUNT');

  const value = req.method === 'fixed' ? req.amountCents : req.basisPoints;
  assertCents(value);

  // Round half up, in integer cents — never floating point money.
  const requestedCents = req.method === 'fixed'
    ? value
    : Math.floor((subtotalCents * value + 5_000) / 10_000);

  const percentageCap = Math.floor((subtotalCents * MAX_DISCOUNT_PCT) / 100);
  const floorHeadroom = Math.max(0, subtotalCents - protectedMinimumCents);
  const appliedCents = Math.min(requestedCents, percentageCap, floorHeadroom);

  // Only report a limit when one actually reduced the request. On a tie the floor is named: it is
  // the constraint that protects real money rather than a policy ceiling.
  const capReason: DiscountCapReason | null = appliedCents < requestedCents
    ? (floorHeadroom <= percentageCap ? 'vehicle_minimum' : 'percentage_cap')
    : null;

  return {
    method: req.method,
    value,
    reason: req.reason.trim(),
    subtotalCents,
    requestedCents,
    appliedCents,
    capReason,
  };
}
