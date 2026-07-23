import type { Booking } from '../../db/bookingRepo';

// Realistic sample bookings used by the dev email-preview harness (routes/devEmails.ts)
// to render every customer email against every booking shape. NOT used in production —
// the harness route is dev-only. Kept close to the shapes in notifications.test.ts.

const customer = {
  firstName: 'Priya',
  lastName: 'Fernando',
  email: 'traveller@example.com',
  whatsapp: '+94771234567',
  country: 'Sri Lanka',
};

const base = {
  id: 'sample-id',
  reference: 'CH-7QK2P',
  status: 'paid' as const,
  createdAt: '2026-08-01T09:00:00.000Z',
  currency: 'LKR',
};

const single: Booking = {
  ...base,
  mode: 'single',
  total: 1_850_000,
  channel: 'website',
  input: {
    from: 'Colombo Fort',
    to: 'Kandy',
    date: '2026-08-09',
    time: '08:30',
    vehicleType: 'car',
    adults: 2,
    children: 0,
    bags: 2,
    customer,
    extras: ['sightseeing'],
  },
};

// Chauffeur multi-day (car kept, driver nights, day rate).
const trip: Booking = {
  ...base,
  reference: 'CH-TRIP1',
  mode: 'trip',
  total: 9_600_000,
  channel: 'website',
  input: {
    stops: ['Colombo Airport', 'Sigiriya', 'Kandy', 'Ella'],
    nights: [0, 2, 2, 2],
    dates: ['2026-08-09', '2026-08-11', '2026-08-13'],
    pax: 3,
    vehicleType: 'van',
    serviceType: 'chauffeur',
    days: 7,
    driverNights: 6,
    customer,
  },
};

const shared: Booking = {
  ...base,
  reference: 'CH-SHR44',
  mode: 'shared',
  total: 480_000,
  channel: 'website',
  input: {
    corridorId: 'ella-mirissa',
    date: '2026-08-09',
    time: '09:00',
    seats: 2,
    customer,
  },
};

export type SampleMode = 'single' | 'trip' | 'shared';

// The three canonical booking shapes, plus useful variants a preview should show.
const byMode: Record<SampleMode, Booking> = { single, trip, shared };

// A single transfer with no date set — exercises the "To confirm" / details-needed path.
const singleFlexible: Booking = { ...single, reference: 'CH-FLEX9', input: { ...single.input, date: undefined, time: undefined } };

// A booking paid with a partial deposit — exercises paidRows() deposit/balance split
// and the (dormant) deposit-received email.
const singleDeposit: Booking = { ...single, reference: 'CH-DEP22', amountDueNow: 185_000 };

// A private multi-stop trip (not chauffeur) — per-stop nights + per-leg dates, no day rate.
const tripPrivate: Booking = {
  ...base,
  reference: 'CH-TRP07',
  mode: 'trip',
  total: 5_400_000,
  channel: 'website',
  input: {
    stops: ['Colombo Fort', 'Kandy', 'Nuwara Eliya', 'Ella'],
    nights: [0, 1, 1, 0],
    dates: ['2026-08-09', '2026-08-10', '2026-08-11'],
    pax: 2,
    vehicleType: 'car',
    serviceType: 'private',
    customer,
  },
};

// A round trip — the origin is repeated as the final stop (the website has no round-trip flag).
const roundTrip: Booking = {
  ...base,
  reference: 'CH-RND09',
  mode: 'trip',
  total: 3_200_000,
  channel: 'website',
  input: {
    stops: ['Kandy', 'Sigiriya', 'Kandy'],
    nights: [0, 1, 0],
    dates: ['2026-08-09', '2026-08-10'],
    pax: 2,
    vehicleType: 'car',
    serviceType: 'private',
    customer,
  },
};

// A rich customer-quote proposal (chauffeur multi-day) for the quote-email preview.
export const sampleQuote = {
  reference: 'CHQ-4821',
  customerFirstName: 'Priya',
  toEmail: 'traveller@example.com',
  currency: 'LKR',
  serviceSummary: 'Chauffeur-guide · 7 days',
  vehicleLabel: 'AC van (up to 6)',
  pax: 4,
  totalCents: 12_600_000,
  validUntil: '2026-08-20',
  stops: [
    { place: 'Colombo Airport', label: 'Start', date: '2026-09-02' },
    { place: 'Sigiriya', label: 'Stop', date: '2026-09-04', nights: 2 },
    { place: 'Kandy', label: 'Stop', date: '2026-09-06', nights: 2 },
    { place: 'Ella', label: 'End', nights: 2 },
  ],
  inclusions: [
    'Private AC van with an English-speaking chauffeur-guide',
    'Fuel, tolls, parking and the driver’s meals & lodging',
    'Airport pickup and door-to-door transfers throughout',
  ],
};

export function sampleBooking(mode: SampleMode): Booking {
  return byMode[mode];
}

export const sampleVariants = { single, trip, shared, singleFlexible, singleDeposit, tripPrivate, roundTrip };
