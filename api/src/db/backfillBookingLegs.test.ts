import { describe, expect, it } from 'vitest';
import { planBackfill, toBackfillRow } from '../../scripts/backfill-booking-legs';

describe('toBackfillRow', () => {
  it('assembles a single transfer with all fields present', () => {
    const row = toBackfillRow(
      { id: 'b1', mode: 'single' },
      {
        id: 't1',
        bookingId: 'b1',
        fromPlace: 'Ella',
        toPlace: 'Kandy',
        travelDate: '2026-08-22',
        travelTime: '09:00',
        vehicleType: 'sedan',
        adults: 2,
        children: 0,
        bags: 2,
        distanceKm: 120,
        durationMin: 180,
      },
      undefined,
    );
    expect(row).toEqual({
      bookingId: 'b1',
      mode: 'single',
      transfer: {
        fromPlace: 'Ella',
        toPlace: 'Kandy',
        travelDate: '2026-08-22',
        travelTime: '09:00',
      },
    });
  });

  it('assembles a trip with a null dates array', () => {
    const row = toBackfillRow(
      { id: 'b2', mode: 'trip' },
      undefined,
      {
        id: 'tr1',
        bookingId: 'b2',
        serviceType: 'private',
        pax: 2,
        vehicleType: 'sedan',
        stops: ['Colombo', 'Galle'],
        nights: [1],
        dates: null,
        days: null,
        driverNights: null,
      },
    );
    expect(row).toEqual({
      bookingId: 'b2',
      mode: 'trip',
      trip: { stops: ['Colombo', 'Galle'], dates: null, serviceType: 'private' },
    });
  });

  it('leaves transfer/trip undefined when the request row is missing', () => {
    expect(toBackfillRow({ id: 'b3', mode: 'single' }, undefined, undefined)).toEqual({
      bookingId: 'b3',
      mode: 'single',
      transfer: undefined,
    });
    expect(toBackfillRow({ id: 'b4', mode: 'trip' }, undefined, undefined)).toEqual({
      bookingId: 'b4',
      mode: 'trip',
      trip: undefined,
    });
  });

  it('assembles a shared booking with no request row at all', () => {
    expect(toBackfillRow({ id: 'b5', mode: 'shared' }, undefined, undefined)).toEqual({
      bookingId: 'b5',
      mode: 'shared',
    });
  });
});

describe('planBackfill', () => {
  it('derives legs for a single transfer and a trip', () => {
    const { legs, skipped } = planBackfill([
      {
        bookingId: 'b1',
        mode: 'single',
        transfer: { fromPlace: 'Ella', toPlace: 'Kandy', travelDate: '2026-08-22', travelTime: '09:00' },
      },
      {
        bookingId: 'b2',
        mode: 'trip',
        trip: { stops: ['A', 'B', 'C'], dates: ['2026-08-22', '2026-08-24'], serviceType: 'private' },
      },
    ]);
    expect(skipped).toEqual([]);
    expect(legs.filter((l) => l.bookingId === 'b1')).toHaveLength(1);
    expect(legs.filter((l) => l.bookingId === 'b2')).toHaveLength(2);
  });

  // A historical row must never be able to stop the backfill — and must never be silently lost.
  it('skips a trip whose stops array is too short, and says why', () => {
    const { legs, skipped } = planBackfill([
      { bookingId: 'b3', mode: 'trip', trip: { stops: ['A'], dates: [], serviceType: 'private' } },
    ]);
    expect(legs).toEqual([]);
    expect(skipped).toEqual([{ bookingId: 'b3', reason: 'no_journey' }]);
  });

  it('skips a booking whose request row is missing entirely', () => {
    const { skipped } = planBackfill([{ bookingId: 'b4', mode: 'single' }]);
    expect(skipped).toEqual([{ bookingId: 'b4', reason: 'missing_request' }]);
  });

  it('ignores shared bookings without reporting them as problems', () => {
    const { legs, skipped } = planBackfill([{ bookingId: 'b5', mode: 'shared' }]);
    expect(legs).toEqual([]);
    expect(skipped).toEqual([]);
  });

  // Finding 2: legRowsForBooking, planBackfill and reconcileBooking each used to treat an
  // unknown `mode` differently, and planBackfill's version was the worst — it fell through the
  // if/else with no branch at all, so an unknown mode vanished with no skip report. `mode` here
  // is a bare string read off the bookings table, not a NewBooking literal, so it genuinely can
  // be something no writer has ever produced (a historical row, a future mode this script
  // hasn't been taught about yet).
  it('reports an unknown mode instead of silently dropping it', () => {
    const { legs, skipped } = planBackfill([{ bookingId: 'b7', mode: 'gift-card' }]);
    expect(legs).toEqual([]);
    expect(skipped).toEqual([{ bookingId: 'b7', reason: 'unknown_mode', detail: 'gift-card' }]);
  });

  it('carries the transfer time onto the leg, so the leg becomes the source of truth', () => {
    const { legs } = planBackfill([
      {
        bookingId: 'b6',
        mode: 'single',
        transfer: { fromPlace: 'A', toPlace: 'B', travelDate: null, travelTime: '06:30' },
      },
    ]);
    expect(legs[0].pickupTime).toBe('06:30');
  });
});
