import { describe, expect, it } from 'vitest';
import { planTripGaps } from '../../scripts/backfill-trip-gaps';

// One-off backfill for trips booked from an ops quote before trip_request.gaps existed
// (known-bugs 2026-07-30 / 2026-08-04). A gap is a stop pair the booking has that no ride in its
// source quote drives — exactly the connector chainStops() inserted.
describe('planTripGaps', () => {
  it('finds the stop pair no quoted ride covers', () => {
    const { updates, skipped } = planTripGaps([
      {
        bookingId: 'b1',
        stops: ['Colombo', 'Ella', 'Galle', 'Colombo'],
        rides: [['Colombo', 'Ella'], ['Galle', 'Colombo']],
      },
    ]);
    expect(updates).toEqual([{ bookingId: 'b1', gaps: [1] }]);
    expect(skipped).toEqual([]);
  });

  it('reads a multi-stop ride as all of its own pairs', () => {
    const { updates } = planTripGaps([
      { bookingId: 'b2', stops: ['A', 'B', 'C', 'D', 'E'], rides: [['A', 'B', 'C'], ['D', 'E']] },
    ]);
    expect(updates).toEqual([{ bookingId: 'b2', gaps: [2] }]);
  });

  it('a partial pay link: the left-out middle leg is a gap, the sold ones are not', () => {
    // The quote had Colombo→Kandy, Kandy→Ella, Ella→Galle; the link sold legs 0 and 2. Every quoted
    // ride is passed in, but Kandy→Ella is not a pair this booking has, so it can't count.
    const { updates } = planTripGaps([
      {
        bookingId: 'b3',
        stops: ['Colombo', 'Kandy', 'Ella', 'Galle'],
        rides: [['Colombo', 'Kandy'], ['Kandy', 'Ella'], ['Ella', 'Galle']],
        soldRides: [0, 2],
      },
    ]);
    expect(updates).toEqual([{ bookingId: 'b3', gaps: [1] }]);
  });

  it('leaves a connected trip alone', () => {
    const { updates, skipped } = planTripGaps([
      { bookingId: 'b4', stops: ['A', 'B', 'C'], rides: [['A', 'B'], ['B', 'C']] },
    ]);
    expect(updates).toEqual([]);
    expect(skipped).toEqual([]);
  });

  // If every pair looks like a gap the quote and the booking don't describe the same trip (edited
  // after conversion, or a different quote). Never guess: report it for a human.
  it('refuses to mark every pair a gap, and says why', () => {
    const { updates, skipped } = planTripGaps([
      { bookingId: 'b5', stops: ['A', 'B', 'C'], rides: [['X', 'Y']] },
    ]);
    expect(updates).toEqual([]);
    expect(skipped).toEqual([{ bookingId: 'b5', reason: 'quote_does_not_match' }]);
  });
});
