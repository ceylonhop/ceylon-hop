import { describe, it, expect } from 'vitest';
import { RIDE_STATUSES, canRideTransition, assertRideTransition } from './rideStatus';

describe('ride fulfilment status', () => {
  it('has the fulfilment lifecycle statuses', () => {
    expect(RIDE_STATUSES).toEqual(['paid', 'vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed', 'no_show']);
  });

  it('allows the forward path', () => {
    expect(canRideTransition('paid', 'vehicle_confirmed')).toBe(true);
    expect(canRideTransition('vehicle_confirmed', 'pickup_confirmed')).toBe(true);
    expect(canRideTransition('pickup_confirmed', 'on_trip')).toBe(true);
    expect(canRideTransition('on_trip', 'completed')).toBe(true);
  });

  it('allows a no-show exit from any active stage, and it is terminal', () => {
    expect(canRideTransition('paid', 'no_show')).toBe(true);
    expect(canRideTransition('vehicle_confirmed', 'no_show')).toBe(true);
    expect(canRideTransition('pickup_confirmed', 'no_show')).toBe(true);
    expect(canRideTransition('on_trip', 'no_show')).toBe(true);
    expect(canRideTransition('no_show', 'paid')).toBe(false);
    expect(canRideTransition('completed', 'no_show')).toBe(false);
  });

  it('allows single-step backtracks except from completed', () => {
    expect(canRideTransition('vehicle_confirmed', 'paid')).toBe(true);
    expect(canRideTransition('pickup_confirmed', 'vehicle_confirmed')).toBe(true);
    expect(canRideTransition('on_trip', 'pickup_confirmed')).toBe(true);
    expect(canRideTransition('completed', 'on_trip')).toBe(false);
  });

  it('rejects skips and old statuses', () => {
    expect(canRideTransition('paid', 'on_trip')).toBe(false);
    // @ts-expect-error old status removed
    expect(canRideTransition('assigned', 'vehicle_confirmed')).toBe(false);
  });

  it('assertRideTransition throws on an illegal move', () => {
    expect(() => assertRideTransition('paid', 'on_trip')).toThrow();
  });
});
