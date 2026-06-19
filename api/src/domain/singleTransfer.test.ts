import { describe, it, expect } from 'vitest';
import { SingleTransferInput } from './singleTransfer';

const valid = {
  from: 'Colombo Airport',
  to: 'Ella',
  vehicleType: 'car',
  adults: 2,
  children: 0,
  bags: 2,
};

describe('SingleTransferInput', () => {
  it('accepts a valid request', () => {
    expect(SingleTransferInput.safeParse(valid).success).toBe(true);
  });

  it('rejects empty or missing from/to', () => {
    expect(SingleTransferInput.safeParse({ ...valid, from: '' }).success).toBe(false);
    const noTo = { from: 'A', vehicleType: 'car', adults: 1, children: 0, bags: 0 };
    expect(SingleTransferInput.safeParse(noTo).success).toBe(false);
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
});
