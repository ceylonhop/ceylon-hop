import { describe, expect, it } from 'vitest';
import { legRowsForBooking } from './postgresBookingRepo';
import type { NewBooking } from './bookingRepo';

const bookingId = '00000000-0000-4000-8000-000000000001';

const customer = { firstName: 'Test', email: 'test@example.com', whatsapp: '+94770000000', country: 'LK' };

function singleBooking(input: Partial<Extract<NewBooking, { mode: 'single' }>['input']>): NewBooking {
  return {
    mode: 'single',
    total: 1000,
    amountDueNow: 1000,
    currency: 'USD',
    input: {
      from: 'Placeholder',
      to: 'Placeholder',
      vehicleType: 'car',
      adults: 1,
      children: 0,
      bags: 0,
      customer,
      ...input,
    },
  };
}

function tripBooking(input: Partial<Extract<NewBooking, { mode: 'trip' }>['input']>): NewBooking {
  return {
    mode: 'trip',
    total: 1000,
    amountDueNow: 1000,
    currency: 'USD',
    input: {
      stops: ['A', 'B'],
      nights: [0],
      pax: 1,
      vehicleType: 'car',
      serviceType: 'private',
      customer,
      ...input,
    },
  };
}

function sharedBooking(input: Partial<Extract<NewBooking, { mode: 'shared' }>['input']>): NewBooking {
  return {
    mode: 'shared',
    total: 1000,
    amountDueNow: 1000,
    currency: 'USD',
    input: {
      corridorId: 'south-coast',
      date: '2026-08-22',
      time: '07:30',
      seats: 2,
      customer,
      ...input,
    },
  };
}

describe('legRowsForBooking', () => {
  it('maps a single transfer to one leg row carrying its date and time', () => {
    const rows = legRowsForBooking(
      bookingId,
      singleBooking({ from: 'Hiriketiya Beach', to: 'Negombo', date: '2026-08-22', time: '08:00' }),
    );
    expect(rows).toEqual([
      {
        bookingId,
        seq: 1,
        kind: 'leg',
        fromPlace: 'Hiriketiya Beach',
        toPlace: 'Negombo',
        viaStops: [],
        travelDate: '2026-08-22',
        pickupTime: '08:00',
      },
    ]);
  });

  it('maps a private trip to one row per consecutive pair', () => {
    const rows = legRowsForBooking(
      bookingId,
      tripBooking({
        stops: ['Galle', 'Ella', 'Kandy'],
        nights: [0, 0],
        dates: ['2026-08-22', '2026-08-25'],
        serviceType: 'private',
      }),
    );
    expect(rows.map((r) => [r.seq, r.kind, r.fromPlace, r.toPlace])).toEqual([
      [1, 'leg', 'Galle', 'Ella'],
      [2, 'leg', 'Ella', 'Kandy'],
    ]);
  });

  it('maps a chauffeur trip by travel day', () => {
    const rows = legRowsForBooking(
      bookingId,
      tripBooking({
        stops: ['Colombo', 'Pinnawala', 'Kandy'],
        nights: [0, 0],
        dates: ['2026-08-22', '2026-08-22'],
        serviceType: 'chauffeur',
      }),
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe('day');
    expect(rows[0].viaStops).toEqual(['Pinnawala']);
  });

  it('produces no rows for a shared seat — a corridor is not a journey with editable ends', () => {
    expect(legRowsForBooking(bookingId, sharedBooking({}))).toEqual([]);
  });

  // Finding 1: booking_legs.from_place/to_place are text NOT NULL, but trip_request.stops is a
  // text[] NOT NULL — Postgres allows a null (or, upstream of validation, an empty-string)
  // element inside that array. A malformed stop must never reach the insert: dropping the leg
  // is recoverable (backfill + reconciliation pick it up); failing the insert rolls back the
  // customer, the booking and the request row inside a payment transaction.
  it('drops a leg whose place is null, and one whose place is empty, without throwing', () => {
    const stops = ['Galle', null as unknown as string, 'Kandy', ''] as string[];
    expect(() =>
      legRowsForBooking(
        bookingId,
        tripBooking({
          stops,
          nights: [0, 0, 0],
          dates: ['2026-08-22', '2026-08-23', '2026-08-24'],
          serviceType: 'private',
        }),
      ),
    ).not.toThrow();
    const rows = legRowsForBooking(
      bookingId,
      tripBooking({
        stops,
        nights: [0, 0, 0],
        dates: ['2026-08-22', '2026-08-23', '2026-08-24'],
        serviceType: 'private',
      }),
    );
    // Galle→null, null→Kandy, and Kandy→'' are all malformed and must not become rows.
    expect(rows).toEqual([]);
    expect(rows.every((r) => typeof r.fromPlace === 'string' && r.fromPlace.length > 0)).toBe(true);
    expect(rows.every((r) => typeof r.toPlace === 'string' && r.toPlace.length > 0)).toBe(true);
  });

  it('keeps the well-formed legs either side of a malformed stop', () => {
    // A B-C-D-E trip where C is null: A→B is fine, B→C and C→D are dropped, D→E is fine.
    const stops = ['A', 'B', null as unknown as string, 'D', 'E'] as string[];
    const rows = legRowsForBooking(
      bookingId,
      tripBooking({
        stops,
        nights: [0, 0, 0, 0],
        serviceType: 'private',
      }),
    );
    expect(rows.map((r) => [r.fromPlace, r.toPlace])).toEqual([
      ['A', 'B'],
      ['D', 'E'],
    ]);
  });
});
