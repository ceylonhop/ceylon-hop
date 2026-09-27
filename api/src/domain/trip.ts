import { z } from 'zod';
import { CustomerInput, QuotedTotal } from './singleTransfer';
import { ROUTE_VARIANTS } from '../quote/routeChoice';

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
  // Planner "gaps": indexes of the wires (stops[i] → stops[i+1]) the traveller arranges
  // themselves — a train, their own transport. Never priced, never measured. The checks that need
  // `stops`/`serviceType` live in the route handler, so TripInput stays a plain ZodObject.
  gaps: z.array(z.number().int().min(0)).max(MAX_TRIP_STOPS - 1).optional(),
  // Customer route choice (spec 2026-09-26-customer-route-choice-design.md §4.2): one entry per
  // consecutive stop pair. The length-matches-legs check lives in the route handler (needs
  // `stops`, so TripInput stays a plain ZodObject); 'fastest' covers "no choice" and gap wires,
  // pricing identically to absent so the column is a plain text[] with no NULL elements.
  routeVariants: z.array(z.enum(ROUTE_VARIANTS)).max(MAX_TRIP_STOPS - 1).optional(),
});

export type TripInput = z.infer<typeof TripInput>;
