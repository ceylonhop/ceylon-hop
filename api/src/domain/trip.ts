import { z } from 'zod';
import { CustomerInput } from './singleTransfer';

// A multi-stop trip from the planner/tour hand-off. `nights` is per stop; `dates` is one
// per leg (the gap between consecutive stops) and optional/flexible. serviceType picks
// leg-by-leg private transfers vs a chauffeur-guide who stays for the whole trip.
export const TripInput = z.object({
  stops: z.array(z.string().min(1)).min(2),
  nights: z.array(z.number().int().min(0)),
  dates: z.array(z.string()).optional(),
  pax: z.number().int().min(1),
  vehicleType: z.enum(['car', 'van']),
  serviceType: z.enum(['private', 'chauffeur']),
  customer: CustomerInput,
});

export type TripInput = z.infer<typeof TripInput>;
