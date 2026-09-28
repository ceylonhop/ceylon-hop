import { describe, it, expect } from 'vitest';
import { toOpsRow } from './opsView';
import type { Booking } from '../db/bookingRepo';

const base: Booking = {
  mode: 'single', id: 'b1', reference: 'CH-AAA11', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
  total: 12100, currency: 'USD', channel: 'website',
  input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 1, bags: 2,
    date: '2026-06-22', time: '09:00',
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
};

describe('opsView', () => {
  it('shapes a single-transfer row with route, pax and payment status', () => {
    const row = toOpsRow(base, { paid: true, rideOps: null });
    expect(row.route).toBe('Colombo Airport → Galle');
    expect(row.pax).toBe(3);
    expect(row.paymentStatus).toBe('paid');
    expect(row.stage).toBe('paid'); // default when no ride_ops
    expect(row.customerFirstName).toBe('Maya');
  });

  // Owner 2026-09-23: the customer's number on every booking row in the ops queue.
  it('carries the customer phone number, or null when there is none', () => {
    expect(toOpsRow(base, { paid: true }).customerPhone).toBe('+34600');
    const none = { ...base, input: { ...base.input, customer: { ...base.input.customer, whatsapp: '  ' } } } as Booking;
    expect(toOpsRow(none, { paid: true }).customerPhone).toBeNull();
  });

  it('marks unpaid bookings', () => {
    expect(toOpsRow({ ...base, status: 'payment_pending' }, { paid: false }).paymentStatus).toBe('unpaid');
  });

  it('stage is awaiting_payment when bookingStatus is payment_pending, regardless of ride_ops', () => {
    const row = toOpsRow(
      { ...base, status: 'payment_pending' },
      {
        paid: false,
        rideOps: {
          bookingId: 'b1', fulfilmentStatus: 'vehicle_confirmed',
          vehiclePhotoReceived: false, customerUpdated: false, opsNotes: null,
          vehicleConfirmedAt: null, updatedAt: '',
        },
      },
    );
    expect(row.stage).toBe('awaiting_payment');
  });

  it('carries ride_ops state (stage, flags) into the row', () => {
    const row = toOpsRow(base, {
      paid: true,
      rideOps: {
        bookingId: 'b1', fulfilmentStatus: 'vehicle_confirmed',
        vehiclePhotoReceived: true, customerUpdated: true, opsNotes: 'gate 4421',
        vehicleConfirmedAt: null, updatedAt: '',
      },
    });
    expect(row.stage).toBe('vehicle_confirmed');
    expect(row.vehiclePhotoReceived).toBe(true);
    expect(row.customerUpdated).toBe(true);
    expect(row.opsNotes).toBe('gate 4421');
  });

  const trip: Booking = {
    mode: 'trip', id: 't1', reference: 'CH-TRIP1', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
    total: 60000, currency: 'USD', channel: 'website',
    input: { stops: ['Colombo Airport', 'Kandy', 'Ella'], nights: [0, 2, 2], dates: ['2026-07-01', '2026-07-03'],
      pax: 4, vehicleType: 'van', serviceType: 'chauffeur',
      customer: { firstName: 'Sam', lastName: 'P', email: 's@x.com', whatsapp: '+1', country: 'US' } },
  };

  it('shapes a trip row (stops joined, pax, first dated leg)', () => {
    const row = toOpsRow(trip, { paid: true });
    expect(row.route).toBe('Colombo Airport → Kandy → Ella');
    expect(row.pax).toBe(4);
    expect(row.travelDate).toBe('2026-07-01');
    expect(row.travelTime).toBeNull();
  });

  const shared: Booking = {
    mode: 'shared', id: 's1', reference: 'CH-SHR01', status: 'paid', createdAt: '2026-06-21T00:00:00Z',
    total: 4000, currency: 'USD', channel: 'website',
    input: { corridorId: 'cmb-galle', date: '2026-07-10', time: '08:00', seats: 3,
      customer: { firstName: 'Ana', lastName: 'R', email: 'a@x.com', whatsapp: '+2', country: 'PT' } },
  };

  it('shapes a shared row (corridor route, seats as pax, date/time)', () => {
    const row = toOpsRow(shared, { paid: true });
    expect(row.route).toBe('Shared · cmb-galle');
    expect(row.pax).toBe(3);
    expect(row.travelDate).toBe('2026-07-10');
    expect(row.travelTime).toBe('08:00');
  });

  // Owner 2026-09-28: a "Recently booked" view (newest first) and a product-type filter. The
  // list needs when each booking came in, and which trips are a chauffeur guide vs a private car.
  it('carries when the booking was made', () => {
    expect(toOpsRow(base, { paid: true }).createdAt).toBe('2026-06-21T00:00:00Z');
  });

  it('carries the trip service type, and null for every other mode', () => {
    expect(toOpsRow(trip, { paid: true }).serviceType).toBe('chauffeur');
    const privateTrip = { ...trip, input: { ...trip.input, serviceType: 'private' } } as Booking;
    expect(toOpsRow(privateTrip, { paid: true }).serviceType).toBe('private');
    expect(toOpsRow(base, { paid: true }).serviceType).toBeNull();
    expect(toOpsRow(shared, { paid: true }).serviceType).toBeNull();
  });

  it('exposes booking channel on the ops row', () => {
    const row = toOpsRow({ ...base, channel: 'whatsapp' }, { paid: true });
    expect(row.channel).toBe('whatsapp');
  });
});

// CH-6HE3V (2026-09-21): the ops row showed `Shared · airport-cultural`, which names
// the corridor, not the journey — so nobody reading the board could tell these two
// travellers get out at Sigiriya rather than riding through to Kandy.
describe('ops row — a shared seat shows the leg it sold', () => {
  const seat: Booking = {
    mode: 'shared', id: 's2', reference: 'CH-6HE3V', status: 'paid', createdAt: '2026-09-21T12:53:39Z',
    total: 5498, currency: 'USD', channel: 'website',
    input: {
      corridorId: 'airport-cultural', fromPlace: 'Colombo Airport (CMB)', toPlace: 'Sigiriya / Dambulla',
      date: '2026-09-23', time: '07:00', seats: 2,
      customer: { firstName: 'Chris', lastName: 'B', email: 'c@x.com', whatsapp: '+61', country: 'AU' },
    },
  };

  it('shows where they board and where they get off', () => {
    expect(toOpsRow(seat, { paid: true }).route).toBe('Shared · Colombo Airport (CMB) → Sigiriya / Dambulla');
  });

  it('keeps the corridor id when the leg was never recorded', () => {
    const legacy = { ...seat, input: { ...seat.input, fromPlace: undefined, toPlace: undefined } } as Booking;
    expect(toOpsRow(legacy, { paid: true }).route).toBe('Shared · airport-cultural');
  });
});

// Test bookings (2026-09-24): a row whose customer email is one of the team's is labelled so
// the queue can show it and leave it out of its counts. Inert when no team set is given.
describe('opsView — isTest', () => {
  const team = new Set(['m@x.com']);
  it('is true when the customer email is a team address (case-insensitive)', () => {
    expect(toOpsRow(base, { paid: true, teamEmails: team }).isTest).toBe(true);
    const upper = { ...base, input: { ...base.input, customer: { ...base.input.customer, email: 'M@X.com' } } } as Booking;
    expect(toOpsRow(upper, { paid: true, teamEmails: team }).isTest).toBe(true);
  });
  it('is false for a customer address', () => {
    expect(toOpsRow(base, { paid: true, teamEmails: new Set(['owner@ceylonhop.com']) }).isTest).toBe(false);
  });
  it('is false when the team set is empty or omitted', () => {
    expect(toOpsRow(base, { paid: true, teamEmails: new Set() }).isTest).toBe(false);
    expect(toOpsRow(base, { paid: true }).isTest).toBe(false);
  });
});

// Route choice (spec §4.3): the queue card says when the customer bought the local road, so ops
// books a driver for the right road. A separate field — `route` feeds search, reminders and the
// Lookup, and stays exactly what it was.
describe('opsView — road', () => {
  it('a transfer on the local road is marked, and its route is untouched', () => {
    const row = toOpsRow({ ...base, input: { ...base.input, routeVariant: 'no_tolls' } } as Booking, { paid: true });
    expect(row.road).toBe('Local road');
    expect(row.route).toBe('Colombo Airport → Galle');
  });

  // A trip names its local legs (roadRow's words): the reminder built from this row goes to the
  // customer, and "via the local road" would be false for the legs on the expressway.
  it('a trip with a leg on the local road names that leg', () => {
    const trip = {
      ...base, mode: 'trip',
      input: { stops: ['Colombo Airport', 'Kandy', 'Ella'], pax: 2, vehicleType: 'car', serviceType: 'private',
        routeVariants: ['fastest', 'no_tolls'], customer: base.input.customer },
    } as unknown as Booking;
    expect(toOpsRow(trip, { paid: true }).road).toBe('Local road for Kandy → Ella');
    const allFast = { ...trip, input: { ...(trip.input as object), routeVariants: ['fastest', 'fastest'] } } as unknown as Booking;
    expect(toOpsRow(allFast, { paid: true }).road).toBeNull();
  });

  it('is null on the expressway, and nothing else in the row changes', () => {
    const fastest = { ...base, input: { ...base.input, routeVariant: 'fastest' } } as Booking;
    expect(toOpsRow(base, { paid: true }).road).toBeNull();
    expect(toOpsRow(fastest, { paid: true })).toEqual(toOpsRow(base, { paid: true }));
  });
});
