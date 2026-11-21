import { describe, it, expect } from 'vitest';
import { tripLegStage } from './tripLegStage';

// Per-leg ops steps (spec 2026-11-19): a private multi-stop trip is as far along as its first
// unfinished leg. Reproduced 2026-11-18: one status for the whole booking meant completing leg 1
// closed a 3-leg trip with two legs still to run.
describe('tripLegStage', () => {
  it('completing leg 1 does not complete the trip: it moves on to leg 2', () => {
    expect(tripLegStage(['completed', 'paid', 'paid'])).toEqual({ currentLeg: 1, stage: 'paid' });
  });

  it('starts at the first leg', () => {
    expect(tripLegStage(['paid', 'paid', 'paid'])).toEqual({ currentLeg: 0, stage: 'paid' });
  });

  it("shows the current leg's own stage", () => {
    expect(tripLegStage(['completed', 'vehicle_confirmed', 'paid'])).toEqual({ currentLeg: 1, stage: 'vehicle_confirmed' });
    expect(tripLegStage(['completed', 'completed', 'on_trip'])).toEqual({ currentLeg: 2, stage: 'on_trip' });
  });

  it('is completed only when every leg is', () => {
    expect(tripLegStage(['completed', 'completed', 'completed'])).toEqual({ currentLeg: null, stage: 'completed' });
  });

  it('follows the first unfinished leg even if a later one was advanced early', () => {
    expect(tripLegStage(['paid', 'vehicle_confirmed'])).toEqual({ currentLeg: 0, stage: 'paid' });
  });

  it('has no stage for a trip with no stored legs — the caller keeps the booking-level status', () => {
    expect(tripLegStage([])).toBeNull();
  });
});
