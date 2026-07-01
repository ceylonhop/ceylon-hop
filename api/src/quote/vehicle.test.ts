import { describe, it, expect } from 'vitest';
import { selectVehicle, vehicleRank, VEHICLE_ORDER } from './vehicle';

describe('selectVehicle', () => {
  it('car for ≤3 pax and ≤3 bags', () => {
    expect(selectVehicle(1, 1)).toBe('car');
    expect(selectVehicle(3, 3)).toBe('car');
  });
  it('van when pax 4–6, or 1–3 pax with too many bags', () => {
    expect(selectVehicle(4, 2)).toBe('van');
    expect(selectVehicle(6, 6)).toBe('van');
    expect(selectVehicle(2, 5)).toBe('van');
  });
  // Previously too_big at 7 pax — now routed to van9
  it('van9 for 7–9 pax (was too_big, now routed to van9)', () => {
    expect(selectVehicle(7, 0)).toBe('van9');
    expect(selectVehicle(9, 8)).toBe('van9');
  });
  it('van14 for 10–14 pax', () => {
    expect(selectVehicle(10, 0)).toBe('van14');
    expect(selectVehicle(14, 12)).toBe('van14');
  });
  it('custom for 15–99 pax', () => {
    expect(selectVehicle(15, 0)).toBe('custom');
    expect(selectVehicle(99, 99)).toBe('custom');
  });
  it('too_big above custom capacity (pax>99)', () => {
    expect(selectVehicle(100, 0)).toBe('too_big');
  });
  it('too_big when bags exceed van max but pax still fits custom (bags>99)', () => {
    expect(selectVehicle(2, 100)).toBe('too_big');
  });
  it('van exactly at van capacity (6 pax, 6 bags)', () => {
    expect(selectVehicle(6, 6)).toBe('van');
  });
  it('van for 4 pax, 6 bags (pax>car max, bags at van max)', () => {
    expect(selectVehicle(4, 6)).toBe('van');
  });
  // Explicit assertions from spec
  it('spec: (2,0)→car, (6,6)→van, (7,0)→van9, (10,0)→van14, (15,0)→custom, (100,0)→too_big', () => {
    expect(selectVehicle(2, 0)).toBe('car');
    expect(selectVehicle(6, 6)).toBe('van');
    expect(selectVehicle(7, 0)).toBe('van9');
    expect(selectVehicle(10, 0)).toBe('van14');
    expect(selectVehicle(15, 0)).toBe('custom');
    expect(selectVehicle(100, 0)).toBe('too_big');
  });
});

describe('vehicleRank', () => {
  it('VEHICLE_ORDER is car, van, van9, van14, custom', () => {
    expect(VEHICLE_ORDER).toEqual(['car', 'van', 'van9', 'van14', 'custom']);
  });
  it('rank increases with tier size', () => {
    expect(vehicleRank('car')).toBe(0);
    expect(vehicleRank('van')).toBe(1);
    expect(vehicleRank('van9')).toBe(2);
    expect(vehicleRank('van14')).toBe(3);
    expect(vehicleRank('custom')).toBe(4);
  });
});
