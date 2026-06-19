import { z } from 'zod';
import { CustomerInput } from './singleTransfer';

// A seat on a fixed daily corridor service. Unlike a private transfer the route and
// departure time are fixed; the customer picks a corridor + date + how many seats.
export const SharedInput = z.object({
  corridorId: z.string().min(1),
  date: z.string().min(1),
  time: z.string().min(1),
  seats: z.number().int().min(1),
  customer: CustomerInput,
});

export type SharedInput = z.infer<typeof SharedInput>;
