export const RIDE_STATUSES = [
  'unassigned', 'assigned', 'sent_to_coordinator', 'acknowledged',
  'vehicle_confirmed', 'customer_updated', 'completed',
] as const;

export type RideStatus = (typeof RIDE_STATUSES)[number];

// Forward path, plus a couple of operational backtracks (re-assign / pull back to assign).
const ALLOWED: Record<RideStatus, RideStatus[]> = {
  unassigned: ['assigned'],
  assigned: ['sent_to_coordinator', 'unassigned'],
  sent_to_coordinator: ['acknowledged', 'assigned'],
  acknowledged: ['vehicle_confirmed', 'assigned'],
  vehicle_confirmed: ['customer_updated', 'assigned'],
  customer_updated: ['completed', 'vehicle_confirmed'],
  completed: [],
};

export function canRideTransition(from: RideStatus, to: RideStatus): boolean {
  if (from === to) return true; // idempotent set
  return ALLOWED[from]?.includes(to) ?? false;
}

export function assertRideTransition(from: RideStatus, to: RideStatus): void {
  if (!canRideTransition(from, to)) throw new Error(`Illegal ride transition: ${from} → ${to}`);
}
