import { describe, it, expect } from 'vitest';
import { quoteSingleTransfer } from './pricing';
import type { SingleTransferInput } from '../domain/singleTransfer';

const base: SingleTransferInput = {
  from: 'A',
  to: 'B',
  vehicleType: 'car',
  adults: 1,
  children: 0,
  bags: 0,
  customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
};

describe('quoteSingleTransfer (stub)', () => {
  it('prices a car for one adult at the base', () => {
    expect(quoteSingleTransfer(base)).toEqual({ currency: 'USD', total: 4000 });
  });

  it('adds per-extra-adult', () => {
    expect(quoteSingleTransfer({ ...base, adults: 3 }).total).toBe(6000);
  });

  it('adds the van surcharge', () => {
    expect(quoteSingleTransfer({ ...base, vehicleType: 'van', adults: 2 }).total).toBe(7000);
  });

  it('is deterministic', () => {
    expect(quoteSingleTransfer(base)).toEqual(quoteSingleTransfer(base));
  });
});
