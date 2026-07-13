export const RIDE_STATUSES = [
  'paid',
  'vehicle_confirmed',
  'pickup_confirmed',
  'on_trip',
  'completed',
  'no_show',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

// Forward path plus single-step operational backtracks (completed is terminal).
// no_show is a terminal exit reachable from any active pre-completion stage.
const ALLOWED: Record<RideStatus, RideStatus[]> = {
  paid: ['vehicle_confirmed', 'no_show'],
  vehicle_confirmed: ['pickup_confirmed', 'paid', 'no_show'],
  pickup_confirmed: ['on_trip', 'vehicle_confirmed', 'no_show'],
  on_trip: ['completed', 'pickup_confirmed', 'no_show'],
  completed: [],
  no_show: [],
};

export function canRideTransition(from: RideStatus, to: RideStatus): boolean {
  if (from === to) return true; // idempotent set
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertRideTransition(from: RideStatus, to: RideStatus): void {
  if (!canRideTransition(from, to)) throw new Error(`Illegal ride transition: ${from} → ${to}`);
}
