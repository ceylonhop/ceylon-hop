import { describe, it, expect } from 'vitest';
import { normalizeRide, normalizeChauffeurDay, rideRawKm, validateRide } from './types';
import type { PrivateLeg, ChauffeurTravelDay, Ride, ChauffeurRideDay } from './types';

describe('normalizeRide', () => {
  it('normalizes an old-shape leg to a 2-stop ride', () => {
    const leg: PrivateLeg = { from: 'Kandy', to: 'Nanu Oya', distanceKm: 80 };
    expect(normalizeRide(leg)).toEqual({ stops: ['Kandy', 'Nanu Oya'], segmentKms: [80] });
  });

  it('passes a Ride through unchanged, by reference-equal fields (no copy drift)', () => {
    const stops = ['A', 'B', 'C'];
    const segmentKms = [10, 20];
    const ride: Ride = { stops, segmentKms };
    const result = normalizeRide(ride);
    expect(result.stops).toBe(stops);
    expect(result.segmentKms).toBe(segmentKms);
  });
});

describe('normalizeChauffeurDay', () => {
  it('normalizes an old-shape chauffeur travel day to a ride day, preserving date', () => {
    const day: ChauffeurTravelDay = { date: '2026-08-01', from: 'Colombo', to: 'Kandy', distanceKm: 120 };
    expect(normalizeChauffeurDay(day)).toEqual({
      date: '2026-08-01',
      stops: ['Colombo', 'Kandy'],
      segmentKms: [120],
    });
  });

  it('passes a ChauffeurRideDay through unchanged, by reference-equal fields', () => {
    const stops = ['A', 'B', 'C'];
    const segmentKms = [10, 20];
    const day: ChauffeurRideDay = { date: '2026-08-02', stops, segmentKms };
    const result = normalizeChauffeurDay(day);
    expect(result.stops).toBe(stops);
    expect(result.segmentKms).toBe(segmentKms);
    expect(result.date).toBe('2026-08-02');
  });
});

describe('rideRawKm', () => {
  it('sums segmentKms', () => {
    expect(rideRawKm({ stops: ['A', 'B'], segmentKms: [80] })).toBe(80);
    expect(rideRawKm({ stops: ['A', 'B', 'C'], segmentKms: [10, 20] })).toBe(30);
  });

  it('returns 0 for a single-segment-less ride (empty segmentKms)', () => {
    expect(rideRawKm({ stops: ['A'], segmentKms: [] })).toBe(0);
  });
});

describe('validateRide', () => {
  it('accepts a valid 2-stop ride', () => {
    expect(() => validateRide({ stops: ['A', 'B'], segmentKms: [10] })).not.toThrow();
  });

  it('accepts an out-and-back with a non-consecutive repeated stop', () => {
    expect(() => validateRide({ stops: ['A', 'B', 'A'], segmentKms: [10, 10] })).not.toThrow();
  });

  it('throws INVALID_RIDE when stops.length < 2', () => {
    expect(() => validateRide({ stops: ['A'], segmentKms: [] })).toThrow('INVALID_RIDE');
  });

  it('throws INVALID_RIDE when segmentKms.length !== stops.length - 1', () => {
    expect(() => validateRide({ stops: ['A', 'B', 'C'], segmentKms: [10] })).toThrow('INVALID_RIDE');
  });

  it('throws INVALID_RIDE when a MULTI-STOP ride has a consecutive equal pair', () => {
    expect(() => validateRide({ stops: ['A', 'A', 'B'], segmentKms: [10, 10] })).toThrow('INVALID_RIDE');
    expect(() => validateRide({ stops: ['A', 'B', 'B'], segmentKms: [10, 10] })).toThrow('INVALID_RIDE');
  });

  it('throws INVALID_RIDE when a multi-stop consecutive pair is equal after trim (whitespace)', () => {
    expect(() => validateRide({ stops: ['A', ' A ', 'B'], segmentKms: [10, 10] })).toThrow('INVALID_RIDE');
  });

  // Back-compat (GC-5): the pre-ride-model engine never compared from/to — it priced a
  // 2-stop leg whose pickup == dropoff (a same-place leg with a manual round-trip km). The
  // consecutive-differ rule is a MULTI-STOP rule (spec §3: no zero-length interior segment),
  // so a normalized old-shape 2-stop ride must still be accepted or stored such quotes 422 on
  // reopen. Only 3+-stop rides reject a consecutive duplicate.
  it('accepts a 2-stop ride whose two stops are equal (old-shape same-place leg)', () => {
    expect(() => validateRide({ stops: ['Ella', 'Ella'], segmentKms: [80] })).not.toThrow();
    expect(() => validateRide({ stops: ['A', ' A '], segmentKms: [10] })).not.toThrow();
  });

  it('throws INVALID_RIDE when a segment km is negative', () => {
    expect(() => validateRide({ stops: ['A', 'B'], segmentKms: [-1] })).toThrow('INVALID_RIDE');
  });

  it('throws INVALID_RIDE when a segment km is not finite', () => {
    expect(() => validateRide({ stops: ['A', 'B'], segmentKms: [Infinity] })).toThrow('INVALID_RIDE');
    expect(() => validateRide({ stops: ['A', 'B'], segmentKms: [NaN] })).toThrow('INVALID_RIDE');
  });
});
