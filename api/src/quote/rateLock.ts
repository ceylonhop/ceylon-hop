import { RATE_CARD, type RateCard } from './rateCard';

// How long a customer web quote's rate card stays locked from first generation (owner 2026-07-11).
// See docs/superpowers/specs/2026-07-11-quote-rate-lock-design.md.
export const RATE_LOCK_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// The lock fields a quote carries. `rateCardJson` = the snapshot the quote was priced against
// (null = never priced/locked). `rateLockedUntil` = when the lock expires (null = no expiry, e.g.
// an ops quote frozen at approval; a `Date` in the future = held; a `Date` in the past = expired).
export type LockedQuote = { rateCardJson: RateCard | null; rateLockedUntil: Date | null };

// The rate card a quote should be priced against right now, plus whether the caller must (re-)stamp
// the quote with the current card (`relock`). Rules (rate-lock spec):
//   • no lock yet            → current card, relock (stamp it at first generation)
//   • locked and still valid → the stored snapshot, no relock
//   • locked but expired     → current card, relock (only a real rate change actually moves the
//                              price — if the version is unchanged the total is identical)
export function rateCardFor(
  quote: LockedQuote,
  now: Date,
  current: RateCard = RATE_CARD,
): { rateCard: RateCard; relock: boolean } {
  if (!quote.rateCardJson) return { rateCard: current, relock: true };
  if (quote.rateLockedUntil == null || quote.rateLockedUntil.getTime() > now.getTime()) {
    return { rateCard: quote.rateCardJson, relock: false };
  }
  return { rateCard: current, relock: true };
}

// The lock expiry for a newly-generated or re-locked customer web quote.
export function rateLockUntil(now: Date): Date {
  return new Date(now.getTime() + RATE_LOCK_WINDOW_MS);
}
