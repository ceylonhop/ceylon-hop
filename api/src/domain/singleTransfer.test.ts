import { describe, it, expect } from 'vitest';
import { SingleTransferInput } from './singleTransfer';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
  customer: {
    firstName: 'Maya', lastName: 'Silva',
    email: 'maya@example.com',
    whatsapp: '+34600000000',
    country: 'Spain',
  },
};

describe('SingleTransferInput', () => {
  it('accepts a valid request', () => {
    expect(SingleTransferInput.safeParse(valid).success).toBe(true);
  });

  it('rejects empty from/to', () => {
    expect(SingleTransferInput.safeParse({ ...valid, from: '' }).success).toBe(false);
    expect(SingleTransferInput.safeParse({ ...valid, to: '' }).success).toBe(false);
  });

  it('rejects adults < 1', () => {
    expect(SingleTransferInput.safeParse({ ...valid, adults: 0 }).success).toBe(false);
  });

  it('rejects negative bags', () => {
    expect(SingleTransferInput.safeParse({ ...valid, bags: -1 }).success).toBe(false);
  });

  it('rejects an unknown vehicleType', () => {
    expect(SingleTransferInput.safeParse({ ...valid, vehicleType: 'boat' }).success).toBe(false);
  });

  it('requires a customer with a valid email', () => {
    expect(SingleTransferInput.safeParse({ ...valid, customer: undefined }).success).toBe(false);
    expect(
      SingleTransferInput.safeParse({
        ...valid,
        customer: { ...valid.customer, email: 'not-an-email' },
      }).success,
    ).toBe(false);
  });

  it('accepts known extras and rejects unknown codes (GL-3)', () => {
    expect(SingleTransferInput.safeParse({ ...valid, extras: ['luggage', 'front'] }).success).toBe(true);
    expect(SingleTransferInput.safeParse({ ...valid, extras: ['jetpack'] }).success).toBe(false);
  });
});
