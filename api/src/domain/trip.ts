import { z } from 'zod';
import { CustomerInput, QuotedTotal } from './singleTransfer';

// A multi-stop trip from the planner/tour hand-off. `nights` is per stop; `dates` is one
// per leg (the gap between consecutive stops) and optional/flexible. serviceType picks
// leg-by-leg private transfers vs a chauffeur-guide who stays for the whole trip.
// Every leg costs a billed Distance Matrix element and a sequential network round trip, so an
// unbounded stops array is both a Maps-spend and a latency amplifier from a single request.
// The ops quote tool already caps a ride at 8 stops; this is the public equivalent, with room
// for the longest tour we sell (9 stops) plus headroom.
export const MAX_TRIP_STOPS = 12;

// A ride is one day's journey: an ordered chain of 2–8 stops, priced as a single leg. The
// 8-stop cap matches the ops tool's, so the two tools can't disagree about what fits in a day.
//
// NO distances. The ops tool sends `segmentKms` because an operator may override them; a
// customer may not — leg distance is a pricing input, so a client-supplied km would let the
// payer set their own price. The server resolves every segment, exactly as it already does
// for the flat chain.
export const TripRide = z
  .object({ stops: z.array(z.string().min(1)).min(2).max(8) })
  .strict();

export const TripInput = z.object({
  stops: z.array(z.string().min(1)).min(2).max(MAX_TRIP_STOPS),
  // Optional GROUPING of `stops` into rides, and nothing more (A2). Absent = today's flat
  // chain, one leg per consecutive pair, byte-for-byte unchanged.
  //
  // It is not cosmetic: the engine buffers km and applies the vehicle floor per RIDE, and the
  // chauffeur day model counts idle days as span − travelDays. So [A,B,C] as one ride and as
  // two rides are different prices, which is exactly what a multi-stop leg has to express.
  //
  // `stops`, `nights` and `dates` keep their existing meaning — dates[i] is still the day you
  // depart stops[i], so the confirmation email's per-stop itinerary needs no change. The route
  // rejects legs that don't flatten back to `stops`.
  legs: z.array(TripRide).min(1).max(MAX_TRIP_STOPS).optional(),
  // Bounded for the same reason, and because `nights` feeds the chauffeur placeholder price.
  nights: z.array(z.number().int().min(0)).max(MAX_TRIP_STOPS),
  dates: z.array(z.string()).max(MAX_TRIP_STOPS).optional(),
  pax: z.number().int().min(1),
  vehicleType: z.enum(['car', 'van']),
  serviceType: z.enum(['private', 'chauffeur']),
  customer: CustomerInput,
  quotedTotal: QuotedTotal,
  // Rate-lock (spec 2026-07-11): a customer web quote id (POST /quote/lock). When present and
  // still within its 7-day window, the trip is priced against that quote's locked card.
  quoteId: z.string().optional(),
  // Chauffeur-guide: days the car is kept + driver accommodation nights (days − 1).
  days: z.number().int().positive().optional(),
  driverNights: z.number().int().min(0).optional(),
});

export type TripInput = z.infer<typeof TripInput>;

/**
 * Do these rides flatten back to exactly this stop chain?
 *
 * Consecutive rides share an endpoint (you set off from where you arrived), so the chain is
 * ride 0's stops followed by each later ride's stops minus its first. A booking whose
 * DISPLAYED route and PRICED route disagree is how a quote→booking conversion silently lost
 * its middle stops once already, so a mismatch is refused rather than reconciled.
 */
export function ridesMatchChain(rides: { stops: string[] }[], stops: string[]): boolean {
  const flat: string[] = [];
  for (const ride of rides) {
    const tail = flat.length ? ride.stops.slice(1) : ride.stops;
    // A ride that doesn't start where the last one ended isn't a continuation of this chain.
    if (flat.length && ride.stops[0] !== flat[flat.length - 1]) return false;
    flat.push(...tail);
  }
  return flat.length === stops.length && flat.every((s, i) => s === stops[i]);
}
