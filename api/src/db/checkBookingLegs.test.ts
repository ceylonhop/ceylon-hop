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
    expect(problems).toEqual([{ ref: 'CH-002', message: 'leg Ella→Galle ≠ transfer Ella→Kandy' }]);
  });

  it('flags a shared booking that wrongly has legs', () => {
    const problems = reconcileBooking(
      { ref: 'CH-003', mode: 'shared' },
      {},
      [{ seq: 1, fromPlace: 'Colombo', toPlace: 'Galle' }],
    );
    expect(problems).toEqual([{ ref: 'CH-003', message: 'shared booking has 1 legs, expected 0' }]);
  });

  it('reports no problems for a chauffeur day row that spans intermediate stops via viaStops', () => {
    // A `day` row legitimately spans several stops — one row can cover the whole trip. This is
    // the case the old endpoint-only check existed to permit; it must not become a false alarm
    // now that the full chain is reconstructed and compared.
    const problems = reconcileBooking(
      { ref: 'CH-004', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [{ seq: 1, fromPlace: 'Colombo', toPlace: 'Galle', viaStops: ['Kandy', 'Ella'] }],
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
    expect(problems).toEqual([{ ref: 'CH-006', message: 'trip with 2 stops has no legs' }]);
  });

  it('flags a single booking with no transfer_request', () => {
    const problems = reconcileBooking({ ref: 'CH-007', mode: 'single' }, {}, []);
    expect(problems).toEqual([{ ref: 'CH-007', message: 'single booking has no transfer_request' }]);
  });

  it('flags a trip booking with no trip_request', () => {
    const problems = reconcileBooking({ ref: 'CH-008', mode: 'trip' }, {}, []);
    expect(problems).toEqual([{ ref: 'CH-008', message: 'trip booking has no trip_request' }]);
  });
});
