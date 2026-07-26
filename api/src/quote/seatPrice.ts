import { RATE_CARD, type RateCard } from './rateCard';

// ────────────────────────────────────────────────────────────────────────────
//  Ride Board seat price (owner decision 2026-07-25)
//
//  A board seat is priced off the SAME engine as a normal transfer leg, not a
//  hand-set corridor rate: take the van fare for the road distance, and divide
//  by three, because three seats are what cover the van. Seats four to six are
//  the margin — which is why a confirmed van with spare seats is worth showing.
//
//  The van floor applies before the split (a short hop still costs a van to
//  run), so the seat floor is effectively floorCents.van / 3. The result is
//  rounded to the nearest 50c so the board shows a clean number.
//
//  The price is ALWAYS the van price. Sending a car when only three travellers
//  join is an operational saving, not a discount — the customer's seat price is
//  fixed when the list is created and never moves.
// ────────────────────────────────────────────────────────────────────────────

/** Seats whose fares together cover the cost of running the van. */
export const SEATS_COVERING_VAN = 3;

/** Board prices are shown to the nearest 50c (same finishing rule as transfers). */
const ROUND_TO_CENTS = 50;

/**
 * Per-seat price, in minor units, for a ride-board list over `km` of road.
 * Throws on a distance that can't be priced — callers must resolve a real road
 * distance first (never a crow-flies estimate).
 */
export function seatPriceForDistance(km: number, card: RateCard = RATE_CARD): number {
  if (!Number.isFinite(km) || km <= 0) {
    throw new Error('seatPriceForDistance: km must be a positive number');
  }
  const vanFare = Math.max(Math.round(km * card.perKmCents.van), card.floorCents.van);
  const perSeat = vanFare / SEATS_COVERING_VAN;
  return Math.round(perSeat / ROUND_TO_CENTS) * ROUND_TO_CENTS;
}
