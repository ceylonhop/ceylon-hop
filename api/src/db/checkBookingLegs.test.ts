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

  it('reports no problems for a trip whose legs start and end where the trip does, even with a multi-stop day row', () => {
    // A `day` row legitimately spans several stops — one row can cover the whole trip. Counts are
    // never compared, only that the chain starts and ends where the trip does.
    const problems = reconcileBooking(
      { ref: 'CH-004', mode: 'trip' },
      { trip: { stops: ['Colombo', 'Kandy', 'Ella', 'Galle'] } },
      [{ seq: 1, fromPlace: 'Colombo', toPlace: 'Galle' }],
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
      { ref: 'CH-005', message: 'legs run Colombo→Galle, trip runs Colombo→Ella' },
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
