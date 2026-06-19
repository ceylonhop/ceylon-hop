import { z } from 'zod';

// The lead traveller — we send confirmation here and contact them about the booking.
export const CustomerInput = z.object({
  name: z.string().min(1),
  email: z.string().email(),
  whatsapp: z.string().min(1),
  country: z.string().min(1),
  marketingOptIn: z.boolean().optional(),
});

export type CustomerInput = z.infer<typeof CustomerInput>;

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
  customer: CustomerInput,
});

export type SingleTransferInput = z.infer<typeof SingleTransferInput>;
