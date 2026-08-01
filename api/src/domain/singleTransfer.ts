import { z } from 'zod';

// A display-only phone part (country code / number) that may arrive as "" from the web booker
// and must be read as "not provided" rather than rejected. The booker emits "" for these when a
// "+"-prefixed number matches no known dial code (e.g. "+0771…"); without this coalesce the whole
// booking 400s at the pay button. Contact/checkout always uses `whatsapp`, so these two are
// informational only — safe to treat empty as absent.
const optionalPhonePart = z.preprocess(
  (v) => (v === '' ? undefined : v),
  z.string().min(1).optional(),
);

// The lead traveller — we send confirmation here and contact them about the booking.
export const CustomerInput = z.object({
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  email: z.string().email(),
  phoneCountryCode: optionalPhonePart,
  phoneNumber: optionalPhonePart,
  whatsapp: z.string().min(1),
  country: z.string().min(1),
  marketingOptIn: z.boolean().optional(),
});

export type CustomerInput = z.infer<typeof CustomerInput>;

// Billing details for the card, collected on the pay page (2026-08-01). Distinct from the
// CustomerInput above, which is the LEAD PASSENGER — who is travelling and who we contact.
// The cardholder name is optional: it is sent only when the payer ticked "billing details are
// different from the lead passenger", and otherwise the lead passenger's name is used.
// address/city/country are required whenever billing is sent at all — the whole point is to
// stop the adapter fabricating them for the payment gateway.
export const BillingInput = z.object({
  firstName: z.string().min(1).optional(),
  lastName: z.string().min(1).optional(),
  address: z.string().min(1),
  city: z.string().min(1),
  country: z.string().min(1),
});

export type BillingInput = z.infer<typeof BillingInput>;

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
