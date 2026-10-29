import { z } from 'zod';
import { CustomerInput, QuotedTotal } from './singleTransfer';

// A shared seat is a real corridor departure, so its date must be a valid ISO calendar date
// (YYYY-MM-DD) — not just any non-empty string. Without this, a malformed/impossible date
// ('tomorrow', '2026-13-45') passes the schema and, because isPastIsoDate treats non-ISO as
// "not past", silently bypasses the no-past-date rule (unlike a private transfer, whose date
// is optional/flexible by design).
const IsoDate = z.string().refine(
  (v) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
    const d = new Date(`${v}T00:00:00Z`);
    return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
  },
  { message: 'date must be a valid ISO calendar date (YYYY-MM-DD)' },
);

// A seat on a fixed-schedule corridor service. Unlike a private transfer the route and
// departure times are fixed, and the service runs only on set weekdays (the corridor's
// service days — see departureRepo `serviceDays`); the customer picks a corridor + date +
// how many seats.
export const SharedInput = z.object({
  corridorId: z.string().min(1),
  // The leg that was actually sold, in the catalogue's own spelling. A corridorId cannot
  // identify a booking — one corridor carries several legs at their own prices — so without
  // these the emails and the ops tool had to guess, and guessed the corridor's far end
  // (CH-6HE3V, 2026-09-21). Optional ONLY because rows predating 2026-09-22 have none.
  fromPlace: z.string().min(1).optional(),
  toPlace: z.string().min(1).optional(),
  // What the extra-bag surcharge was computed from. Optional only for rows predating 0052.
  bags: z.number().int().min(0).optional(),
  date: IsoDate,
  time: z.string().min(1),
  seats: z.number().int().min(1),
  customer: CustomerInput,
});

export type SharedInput = z.infer<typeof SharedInput>;

// The add-ons a shared seat can carry, and what the customer and ops call them. Hotel pick-up and
// hotel drop-off (owner 2026-10-16, two $5 add-ons since 2026-10-29): each once per booking, hotel
// within 5 km of the meeting point.
export const SHARED_EXTRA_CODES = ['hotel-pickup', 'hotel-dropoff'] as const;
export const SHARED_EXTRA_LABELS: Record<typeof SHARED_EXTRA_CODES[number], string> = {
  'hotel-pickup': 'Hotel pick-up',
  'hotel-dropoff': 'Hotel drop-off',
};

// HTTP request shape: the website sends from/to (it doesn't know corridor ids), and the
// API resolves the corridor. A corridorId is also accepted directly.
export const SharedBookingRequest = z.object({
  corridorId: z.string().min(1).optional(),
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  date: IsoDate,
  time: z.string().min(1),
  seats: z.number().int().min(1),
  bags: z.number().int().min(0).optional(),
  // The add-ons a shared seat can carry, priced server-side from RATE_CARD.extras.
  extras: z.array(z.enum(SHARED_EXTRA_CODES)).optional(),
  customer: CustomerInput,
  quotedTotal: QuotedTotal,
});

export type SharedBookingRequest = z.infer<typeof SharedBookingRequest>;
