import { z } from 'zod';

// The lead traveller — we send confirmation here and contact them about the booking.
export const CustomerInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phoneCountryCode: z.string().min(1).optional(),
  phoneNumber: z.string().min(1).optional(),
  whatsapp: z.string().min(1),
  country: z.string().min(1),
  marketingOptIn: z.boolean().optional(),
});

export type CustomerInput = z.infer<typeof CustomerInput>;

// The total the customer was quoted on the site, in minor units (cents). The booking
// records THIS — the price they agreed to — instead of a recomputed server stub, so the
// confirmation, the DB, and the eventual charge all match. Bounded to reject tampering
// ($1–$1,000,000). Absent => fall back to the server quote (API-only callers / tests).
// The authoritative server-side pricing engine replaces this passthrough in M11.
export const QuotedTotal = z.number().int().min(100).max(100_000_000).optional();

// The validated shape of a single-transfer booking request. `date`/`time` are optional —
// an absent value means "flexible, confirm later" (matches the front-end's Decide-later).
// `extras` are the engine's ExtraCode values (GL-3) — priced server-side, never by the client.
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
  quotedTotal: QuotedTotal,
  // Rate-lock (spec 2026-07-11): a customer web quote id (POST /quote/lock). When present and
  // still within its 7-day window, the booking is priced against that quote's locked card.
  quoteId: z.string().optional(),
  extras: z.array(z.enum(['sightseeing', 'luggage', 'front', 'flex', 'waiting', 'safari-wait'])).optional(),
});

export type SingleTransferInput = z.infer<typeof SingleTransferInput>;
