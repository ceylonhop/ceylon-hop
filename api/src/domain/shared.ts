import { z } from 'zod';
import { CustomerInput, QuotedTotal } from './singleTransfer';

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

// HTTP request shape: the website sends from/to (it doesn't know corridor ids), and the
// API resolves the corridor. A corridorId is also accepted directly.
export const SharedBookingRequest = z.object({
  corridorId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  date: z.string().min(1),
  time: z.string().min(1),
  seats: z.number().int().min(1),
  customer: CustomerInput,
  quotedTotal: QuotedTotal,
});

export type SharedBookingRequest = z.infer<typeof SharedBookingRequest>;
