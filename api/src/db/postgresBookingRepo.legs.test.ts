import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { legRowsForBooking, safeLegRowsForBooking } from './postgresBookingRepo';
import type { NewBooking } from './bookingRepo';
import * as trackModule from '../observability/track';

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
  //
  // The filtering itself now lives in deriveLegsForMode (domain/bookingLegs.ts) — see the
  // "usable-place filtering" tests there — so this is integration coverage that legRowsForBooking
  // still gets that behaviour through the shared dispatch, plus that it wires bookingId correctly.
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

// Finding 3: legRowsForBooking guards VALUES (a null/empty place), not SHAPES. A `stops` that
// isn't an array, or a `dates` that isn't an array for a chauffeur trip, still throws inside
// deriveTripLegs/chauffeurDays — and legRowsForBooking is called from inside insertBooking's
// transaction, after the customer, booking and request rows are already written. None of these
// shapes are reachable today (trip_request.stops is `text[] NOT NULL`, quoteToBooking builds
// both arrays itself, zod validates the website path) but the claim "this insert cannot fail a
// payment" has to hold for shapes too, not just values — so insertBooking calls
// safeLegRowsForBooking, which turns any throw into "no legs" instead of a failed booking.
describe('safeLegRowsForBooking', () => {
  beforeEach(() => {
    vi.spyOn(trackModule, 'track').mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the same rows as legRowsForBooking when derivation does not throw', () => {
    const booking = tripBooking({ stops: ['Galle', 'Ella'], nights: [0], serviceType: 'private' });
    expect(safeLegRowsForBooking(bookingId, booking)).toEqual(legRowsForBooking(bookingId, booking));
    expect(trackModule.track).not.toHaveBeenCalled();
  });

  it('yields no legs, without throwing, when stops is not an array (a shape the deriver cannot handle)', () => {
    const booking = tripBooking({
      stops: 'not-an-array' as unknown as string[],
      serviceType: 'private',
    });
    expect(() => safeLegRowsForBooking(bookingId, booking)).not.toThrow();
    expect(safeLegRowsForBooking(bookingId, booking)).toEqual([]);
  });

  it('yields no legs, without throwing, when dates is not an array for a chauffeur trip', () => {
    const booking = tripBooking({
      stops: ['A', 'B', 'C'],
      dates: 'not-an-array' as unknown as string[],
      serviceType: 'chauffeur',
    });
    expect(() => safeLegRowsForBooking(bookingId, booking)).not.toThrow();
    expect(safeLegRowsForBooking(bookingId, booking)).toEqual([]);
  });

  it('records the failure via track() rather than swallowing it silently', () => {
    const booking = tripBooking({ stops: 'not-an-array' as unknown as string[], serviceType: 'private' });
    safeLegRowsForBooking(bookingId, booking);
    expect(trackModule.track).toHaveBeenCalledTimes(1);
    const [err, ctx] = vi.mocked(trackModule.track).mock.calls[0];
    expect(err).toBeInstanceOf(Error);
    expect(ctx).toMatchObject({ extra: { bookingId, mode: 'trip' } });
  });
});
