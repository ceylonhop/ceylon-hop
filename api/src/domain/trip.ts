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

export const TripInput = z.object({
  stops: z.array(z.string().min(1)).min(2).max(MAX_TRIP_STOPS),
  // Bounded for the same reason, and because `nights` feeds the chauffeur placeholder price.
  nights: z.array(z.number().int().min(0)).max(MAX_TRIP_STOPS),
  dates: z.array(z.string()).max(MAX_TRIP_STOPS).optional(),
  // Per-SEGMENT (stops[i] → stops[i+1]) flag: true = we drive it, false = the customer
  // arranges that hop themselves. Optional, and ABSENT MEANS ALL DRIVEN — every website
  // booking and every row written before gaps existed omits it and must keep behaving as
  // it always has. Present only on bookings converted from an ops quote whose legs don't
  // connect, which is a legitimate itinerary (a customer taking the train Ella→Galle), not
  // an error to reject.
  driven: z.array(z.boolean()).max(MAX_TRIP_STOPS).optional(),
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
