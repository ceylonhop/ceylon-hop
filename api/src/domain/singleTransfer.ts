import { z } from 'zod';

// What people type around the digits — "+94 77 123 4567", "077-123-4567", "+44 (0)7700 900123".
// Dropped for the CHECK only: the value is stored exactly as sent (validation, not
// normalisation — the wa.me links already strip for themselves).
const PHONE_PUNCTUATION = /[\s\-().]/g;
const digitsOf = (v: string) => v.replace(PHONE_PUNCTUATION, '');

// Every phone field is bounded (CH-T74DT, 2026-08-27: a website booking landed with a 26-digit
// WhatsApp number and a 24-digit phone number under the name "dsad sdax" — the schema checked
// for presence and nothing else, on all three create routes). E.164 caps a full number at 15
// digits and a country code at 3; the floors keep out "+1" and "123". The messages name the box
// and the rule, because the booker's overlay, pay.html and the ops toast all show the server's
// `message` verbatim.
const DIAL_CODE = /^\+\d{1,3}$/;
const NATIONAL_NUMBER = /^\d{4,15}$/;
const INTERNATIONAL_NUMBER = /^\+\d{6,15}$/;

// A display-only phone part (country code / number) that may arrive as "" from the web booker
// and must be read as "not provided" rather than rejected. The booker emits "" for these when a
// "+"-prefixed number matches no known dial code (e.g. "+0771…"); without this coalesce the whole
// booking 400s at the pay button. Contact/checkout always uses `whatsapp`, so these two are
// informational only — safe to treat empty as absent.
const optionalPhonePart = <T extends z.ZodTypeAny>(inner: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), inner.optional());

const phoneCountryCode = optionalPhonePart(
  z.string().regex(DIAL_CODE, 'Dial code must be + followed by 1–3 digits (e.g. +94)'),
);
const phoneNumber = optionalPhonePart(
  z.string().refine((v) => NATIONAL_NUMBER.test(digitsOf(v)), 'Phone number must be 4–15 digits'),
);
const whatsapp = z
  .string()
  .refine(
    (v) => INTERNATIONAL_NUMBER.test(digitsOf(v)),
    'WhatsApp number must be + followed by 6–15 digits (e.g. +94771234567)',
  );

// The lead traveller — we send confirmation here and contact them about the booking.
export const CustomerInput = z.object({
  firstName: z.string().min(1),
  // Optional since 2026-08-08. A phone-only quote renders this box EMPTY, and requiring it meant
  // the operator previewing a pay link had to fill something to continue — so Chrome's autofill
  // filled it, and four live bookings were recorded under the owner's surname. The ops quote form
  // has always treated it as optional; these two ends now agree. PayHere already tolerates it
  // (`last_name: c?.lastName ?? '-'`), and names render as [first,last].filter(Boolean).
  lastName: z.string().optional(),
  email: z.string().email(),
  phoneCountryCode,
  phoneNumber,
  whatsapp,
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
  // Optional so a cached older page keeps working; the form requires it client-side.
  postcode: z.string().min(1).optional(),
  // Optional in every sense: most countries have no state, and no payer is blocked on it.
  state: z.string().min(1).optional(),
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
