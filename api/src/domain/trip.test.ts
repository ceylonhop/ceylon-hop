import { describe, it, expect } from 'vitest';
import { TripInput } from './trip';

const valid = {
  stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
  nights: [1, 2, 0],
  dates: ['2026-07-20', '2026-07-22'],
  pax: 2,
  vehicleType: 'van',
  serviceType: 'private',
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('TripInput', () => {
  it('accepts a valid multi-stop trip', () => {
    expect(TripInput.safeParse(valid).success).toBe(true);
  });

  it('requires at least two stops', () => {
    expect(TripInput.safeParse({ ...valid, stops: ['Colombo Airport'] }).success).toBe(false);
  });

  it('rejects an unknown serviceType', () => {
    expect(TripInput.safeParse({ ...valid, serviceType: 'taxi' }).success).toBe(false);
  });

  it('requires a valid customer', () => {
    expect(
      TripInput.safeParse({ ...valid, customer: { ...valid.customer, email: 'nope' } }).success,
    ).toBe(false);
  });
});
