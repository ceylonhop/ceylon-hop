import { describe, expect, it } from 'vitest';
import { planBackfill } from '../../scripts/backfill-booking-legs';

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
