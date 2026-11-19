import type { RideStatus } from './rideStatus';

// Per-leg ops steps (spec 2026-11-19). Each driven leg of a private multi-stop trip has its own
// fulfilment status. 'no_show' is left out on purpose: a no-show closes the whole booking, so it
// stays on the booking's own ride_ops row.
export type LegRideStatus = Exclude<RideStatus, 'no_show'>;

/**
 * How far along a trip is, from its legs' statuses in travel order: the first leg that is not
 * completed, and that leg's stage. Completed only when every leg is. Null for a trip with no
 * stored legs — the caller keeps the booking-level status for those.
 */
export function tripLegStage(
  legs: readonly LegRideStatus[],
): { currentLeg: number | null; stage: LegRideStatus } | null {
  if (legs.length === 0) return null;
  const currentLeg = legs.findIndex((s) => s !== 'completed');
  if (currentLeg === -1) return { currentLeg: null, stage: 'completed' };
  return { currentLeg, stage: legs[currentLeg] };
}
