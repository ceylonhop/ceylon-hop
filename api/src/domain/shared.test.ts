import { describe, it, expect } from 'vitest';
import { SharedInput } from './shared';

const valid = {
  corridorId: 'cmb-ella',
  date: '2026-07-20',
  time: '07:30',
  seats: 2,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('SharedInput', () => {
  it('accepts a valid shared-seat request', () => {
    expect(SharedInput.safeParse(valid).success).toBe(true);
  });

  it('requires at least one seat', () => {
    expect(SharedInput.safeParse({ ...valid, seats: 0 }).success).toBe(false);
  });

  it('requires a date and time (fixed schedule)', () => {
    expect(SharedInput.safeParse({ ...valid, date: '' }).success).toBe(false);
    expect(SharedInput.safeParse({ ...valid, time: '' }).success).toBe(false);
  });

  it('requires a valid customer', () => {
    expect(
      SharedInput.safeParse({ ...valid, customer: { ...valid.customer, email: 'nope' } }).success,
    ).toBe(false);
  });
});
