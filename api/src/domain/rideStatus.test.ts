import { describe, it, expect } from 'vitest';
import { RIDE_STATUSES, canRideTransition, assertRideTransition } from './rideStatus';

describe('ride fulfilment status', () => {
  it('lists the seven states', () => {
    expect(RIDE_STATUSES).toEqual([
      'unassigned', 'assigned', 'sent_to_coordinator', 'acknowledged',
      'vehicle_confirmed', 'customer_updated', 'completed',
    ]);
  });
  it('allows the forward path', () => {
    expect(canRideTransition('unassigned', 'assigned')).toBe(true);
    expect(canRideTransition('assigned', 'sent_to_coordinator')).toBe(true);
    expect(canRideTransition('vehicle_confirmed', 'customer_updated')).toBe(true);
  });
  it('rejects skipping and going backwards', () => {
    expect(canRideTransition('unassigned', 'completed')).toBe(false);
    expect(canRideTransition('completed', 'assigned')).toBe(false);
  });
  it('allows re-assigning a coordinator (assigned → assigned) and un-assigning', () => {
    expect(canRideTransition('assigned', 'unassigned')).toBe(true);
    expect(canRideTransition('sent_to_coordinator', 'assigned')).toBe(true); // re-assign after send
  });
  it('assertRideTransition throws on an illegal move', () => {
    expect(() => assertRideTransition('unassigned', 'completed')).toThrow();
  });
});
