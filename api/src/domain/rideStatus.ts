export const RIDE_STATUSES = [
  'paid',
  'vehicle_confirmed',
  'pickup_confirmed',
  'on_trip',
  'completed',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

// Forward path plus single-step operational backtracks (completed is terminal).
const ALLOWED: Record<RideStatus, RideStatus[]> = {
  paid: ['vehicle_confirmed'],
  vehicle_confirmed: ['pickup_confirmed', 'paid'],
  pickup_confirmed: ['on_trip', 'vehicle_confirmed'],
  on_trip: ['completed', 'pickup_confirmed'],
  completed: [],
};

export function canRideTransition(from: RideStatus, to: RideStatus): boolean {
  if (from === to) return true; // idempotent set
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertRideTransition(from: RideStatus, to: RideStatus): void {
  if (!canRideTransition(from, to)) throw new Error(`Illegal ride transition: ${from} → ${to}`);
}
