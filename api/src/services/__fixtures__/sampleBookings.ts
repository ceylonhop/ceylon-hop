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
  },
};

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

export function sampleBooking(mode: SampleMode): Booking {
  return byMode[mode];
}

export const sampleVariants = { single, trip, shared, singleFlexible, singleDeposit };
