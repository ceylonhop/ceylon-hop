import { describe, it, expect } from 'vitest';
import { selectVehicle } from './vehicle';

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
  it('too_big above van capacity', () => {
    expect(selectVehicle(7, 1)).toBe('too_big');
  });
  it('too_big when bags exceed van max (2 pax, 7 bags)', () => {
    expect(selectVehicle(2, 7)).toBe('too_big');
  });
  it('van exactly at van capacity (6 pax, 6 bags)', () => {
    expect(selectVehicle(6, 6)).toBe('van');
  });
  it('van for 4 pax, 6 bags (pax>car max, bags at van max)', () => {
    expect(selectVehicle(4, 6)).toBe('van');
  });
});
