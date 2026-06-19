import { z } from 'zod';

// The validated shape of a single-transfer booking request. `date`/`time` are optional —
// an absent value means "flexible, confirm later" (matches the front-end's Decide-later).
export const SingleTransferInput = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  date: z.string().optional(),
  time: z.string().optional(),
  vehicleType: z.enum(['car', 'van']),
  adults: z.number().int().min(1),
  children: z.number().int().min(0),
  bags: z.number().int().min(0),
});

export type SingleTransferInput = z.infer<typeof SingleTransferInput>;
