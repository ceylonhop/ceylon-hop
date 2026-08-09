import { describe, expect, it } from 'vitest';
import { reconcileBooking } from './checkBookingLegs';

describe('reconcileBooking', () => {
  it('reports no problems for a matching single transfer', () => {
    const problems = reconcileBooking(
      { ref: 'CH-001', mode: 'single' },
      { transfer: { fromPlace: 'Ella', toPlace: 'Kandy' } },
      [{ seq: 1, fromPlace: 'Ella', toPlace: 'Kandy' }],
    );
    expect(problems).toEqual([]);
  });

  it('flags a single transfer whose leg endpoints disagree with transfer_request', () => {
    const problems = reconcileBooking(
      { ref: 'CH-002', mode: 'single' },
      { transfer: { fromPlace: 'Ella', toPlace: 'Kandy' } },
      [{ seq: 1, fromPlace: 'Ella', toPlace: 'Galle' }],
    );
    expect(problems).toEqual([
      { ref: 'CH-002', reason: 'endpoint_mismatch', message: 'leg Ella→Galle ≠ transfer Ella→Kandy' },
    ]);
  });

  it('flags a shared booking that wrongly has legs', () => {
    const problems = reconcileBooking(
      { ref: 'CH-003', mode: 'shared' },
      {},
      [{ seq: 1, fromPlace: 'Colombo', toPlace: 'Galle' }],
    );
    expect(problems).toEqual([
      { ref: 'CH-003', reason: 'shared_has_legs', message: 'shared booking has 1 leg, expected 0' },
    ]);
  });

  // Finding 6: the message must pluralise correctly — this used to always say "legs" even for 1.
  it('pluralises "legs" correctly when a shared booking wrongly has more than one', () => {
    const problems = reconcileBooking(
      { ref: 'CH-013', mode: 'shared' },
      {},
      [
        { seq: 1, fromPlace: 'Colombo', toPlace: 'Galle' },
        { seq: 2, fromPlace: 'Galle', toPlace: 'Matara' },
      ],
    );
    expect(problems).toEqual([
      { ref: 'CH-013', reason: 'shared_has_legs', message: 'shared booking has 2 legs, expected 0' },
    ]);
  });

  it('reports no problems for a chauffeur day row that spans intermediate stops via viaStops', () => {
    // A `day` row legitimately spans several stops — one row can cover the whole trip. This is
    // the case the old endpoint-only check existed to permit; it must not become a false alarm
    // now that the full chain is reconstructed and compared.
    const problems = reconcileBooking(
      { ref: 'CH-004', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [{ seq: 1, kind: 'day', fromPlace: 'Colombo', toPlace: 'Galle', viaStops: ['Kandy', 'Ella'] }],
    );
    expect(problems).toEqual([]);
  });

  // Finding 1: a legitimate multi-stop chauffeur booking — several `day` rows, no `gap` at all —
  // must still reconcile clean now that the all-gap check exists alongside it.
  it('reports no problems for a legitimate multi-stop chauffeur day booking', () => {
    const problems = reconcileBooking(
      { ref: 'CH-014', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [
        { seq: 1, kind: 'day', fromPlace: 'Colombo', toPlace: 'Kandy', viaStops: [] },
        { seq: 2, kind: 'day', fromPlace: 'Kandy', toPlace: 'Ella', viaStops: [] },
        { seq: 3, kind: 'day', fromPlace: 'Ella', toPlace: 'Galle', viaStops: [] },
      ],
    );
    expect(problems).toEqual([]);
  });

  it('flags a trip whose leg chain does not match the trip', () => {
    const problems = reconcileBooking(
      { ref: 'CH-005', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella'] } },
      [
        { seq: 1, fromPlace: 'Colombo', toPlace: 'Kandy' },
        { seq: 2, fromPlace: 'Kandy', toPlace: 'Galle' },
      ],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-005',
        reason: 'route_mismatch',
        message:
          'legs imply Colombo→Kandy→Galle (3 stops), trip stops are Colombo→Kandy→Ella (3 stops) — diverge at stop 3',
      },
    ]);
  });

  it('flags a trip with a missing middle leg', () => {
    const problems = reconcileBooking(
      { ref: 'CH-009', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [
        { seq: 1, fromPlace: 'Colombo', toPlace: 'Kandy' },
        // Kandy→Ella leg is missing entirely.
        { seq: 2, fromPlace: 'Ella', toPlace: 'Galle' },
      ],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-009',
        reason: 'route_mismatch',
        message:
          'legs imply Colombo→Kandy→Galle (3 stops), trip stops are Colombo→Kandy→Ella→Galle (4 stops) — diverge at stop 3',
      },
    ]);
  });

  it('flags a trip with a duplicated leg', () => {
    const problems = reconcileBooking(
      { ref: 'CH-010', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella'] } },
      [
        { seq: 1, fromPlace: 'Colombo', toPlace: 'Kandy' },
        { seq: 2, fromPlace: 'Colombo', toPlace: 'Kandy' }, // duplicate of leg 1
        { seq: 3, fromPlace: 'Kandy', toPlace: 'Ella' },
      ],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-010',
        reason: 'route_mismatch',
        message:
          'legs imply Colombo→Kandy→Kandy→Ella (4 stops), trip stops are Colombo→Kandy→Ella (3 stops) — diverge at stop 3',
      },
    ]);
  });

  it('flags a trip whose day leg routes through the wrong intermediate stop', () => {
    const problems = reconcileBooking(
      { ref: 'CH-011', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [{ seq: 1, fromPlace: 'Colombo', toPlace: 'Galle', viaStops: ['Kandy', 'Nuwara Eliya'] }],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-011',
        reason: 'route_mismatch',
        message:
          'legs imply Colombo→Kandy→Nuwara Eliya→Galle (4 stops), trip stops are Colombo→Kandy→Ella→Galle (4 stops) — diverge at stop 3',
      },
    ]);
  });

  it('flags a trip whose legs are recorded out of order', () => {
    const problems = reconcileBooking(
      { ref: 'CH-012', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [
        { seq: 1, fromPlace: 'Ella', toPlace: 'Galle' },
        { seq: 2, fromPlace: 'Colombo', toPlace: 'Kandy' },
        { seq: 3, fromPlace: 'Kandy', toPlace: 'Ella' },
      ],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-012',
        reason: 'route_mismatch',
        message:
          'legs imply Ella→Galle→Kandy… (4 stops), trip stops are Colombo→Kandy→Ella… (4 stops) — diverge at stop 1',
      },
    ]);
  });

  it('flags a trip with no legs at all', () => {
    const problems = reconcileBooking(
      { ref: 'CH-006', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy'] } },
      [],
    );
    expect(problems).toEqual([{ ref: 'CH-006', reason: 'no_legs', message: 'trip with 2 stops has no legs' }]);
  });

  it('flags a single booking with no transfer_request', () => {
    const problems = reconcileBooking({ ref: 'CH-007', mode: 'single' }, {}, []);
    expect(problems).toEqual([
      { ref: 'CH-007', reason: 'missing_transfer_request', message: 'single booking has no transfer_request' },
    ]);
  });

  it('flags a trip booking with no trip_request', () => {
    const problems = reconcileBooking({ ref: 'CH-008', mode: 'trip' }, {}, []);
    expect(problems).toEqual([
      { ref: 'CH-008', reason: 'missing_trip_request', message: 'trip booking has no trip_request' },
    ]);
  });

  // Finding 5: an unknown booking.mode (e.g. a future mode this script hasn't been taught about
  // yet) used to fall through into the trip branch and get reported as `missing_trip_request` —
  // technically true (there's no trip_request row) but a misleading reason: the actual problem is
  // that the mode itself is unrecognised, not that a trip is missing its request row.
  it('gives an unrecognised mode its own problem reason instead of reporting missing_trip_request', () => {
    const problems = reconcileBooking({ ref: 'CH-020', mode: 'gift-card' }, {}, []);
    expect(problems).toEqual([
      { ref: 'CH-020', reason: 'unknown_mode', message: 'unrecognised booking mode "gift-card"' },
    ]);
  });

  // Finding 1, assertion 1: an undated chauffeur trip used to derive all-gap rows, which
  // reconstruct the stop chain perfectly and so passed silently — a booking with no journeys
  // authorising the next phase. `kind: 'gap'` is explicitly "never a journey we drive as one".
  it('flags a trip whose legs are all gap, even though the stop chain reconstructs cleanly', () => {
    const problems = reconcileBooking(
      { ref: 'CH-015', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella'] } },
      [
        { seq: 1, kind: 'gap', fromPlace: 'Colombo', toPlace: 'Kandy' },
        { seq: 2, kind: 'gap', fromPlace: 'Kandy', toPlace: 'Ella' },
      ],
    );
    expect(problems).toEqual([
      { ref: 'CH-015', reason: 'all_gap', message: 'trip has 2 legs, all gap — no journeys' },
    ]);
  });

  it('does not flag a trip that mixes gap connectors with real day/leg rows', () => {
    const problems = reconcileBooking(
      { ref: 'CH-016', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Galle'] } },
      [
        { seq: 1, kind: 'day', fromPlace: 'Colombo', toPlace: 'Kandy' },
        { seq: 2, kind: 'gap', fromPlace: 'Kandy', toPlace: 'Galle' },
      ],
    );
    expect(problems).toEqual([]);
  });

  // Finding 1, assertion 2: the backfill's central claim is that the leg becomes the source of
  // truth for departure time. This is the one check that verifies it.
  it('flags a single booking whose transfer has travel_time but leg pickup_time is null', () => {
    const problems = reconcileBooking(
      { ref: 'CH-017', mode: 'single' },
      { transfer: { fromPlace: 'Ella', toPlace: 'Kandy', travelTime: '09:00' } },
      [{ seq: 1, fromPlace: 'Ella', toPlace: 'Kandy', pickupTime: null }],
    );
    expect(problems).toEqual([
      {
        ref: 'CH-017',
        reason: 'stale_pickup_time',
        message: 'transfer_request.travel_time is 09:00 but leg pickup_time is null',
      },
    ]);
  });

  it('reports no problems when the leg carries the transfer_request travel_time', () => {
    const problems = reconcileBooking(
      { ref: 'CH-018', mode: 'single' },
      { transfer: { fromPlace: 'Ella', toPlace: 'Kandy', travelTime: '09:00' } },
      [{ seq: 1, fromPlace: 'Ella', toPlace: 'Kandy', pickupTime: '09:00' }],
    );
    expect(problems).toEqual([]);
  });

  it('does not flag a single booking with no travel_time recorded at all', () => {
    const problems = reconcileBooking(
      { ref: 'CH-019', mode: 'single' },
      { transfer: { fromPlace: 'Ella', toPlace: 'Kandy' } },
      [{ seq: 1, fromPlace: 'Ella', toPlace: 'Kandy', pickupTime: null }],
    );
    expect(problems).toEqual([]);
  });
});
