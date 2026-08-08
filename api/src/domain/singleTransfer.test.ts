import { describe, it, expect } from 'vitest';
import { SingleTransferInput, CustomerInput } from './singleTransfer';

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

  // The web booker emits phoneCountryCode/phoneNumber = "" (not undefined) when a customer types a
  // "+"-prefixed number that matches no known dial code (e.g. "+0771…"). These fields are display-only
  // (contact/checkout uses `whatsapp`), so an empty value must be treated as absent, not 400 the booking.
  it('treats an empty phone country code/number as absent (no false 400 at the pay button)', () => {
    const res = SingleTransferInput.safeParse({
      ...valid,
      customer: { ...valid.customer, phoneCountryCode: '', phoneNumber: '' },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.customer.phoneCountryCode).toBeUndefined();
      expect(res.data.customer.phoneNumber).toBeUndefined();
    }
  });

  it('still accepts a present, non-empty phone country code + number', () => {
    const res = SingleTransferInput.safeParse({
      ...valid,
      customer: { ...valid.customer, phoneCountryCode: '+94', phoneNumber: '771234567' },
    });
    expect(res.success).toBe(true);
    if (res.success) {
      expect(res.data.customer.phoneCountryCode).toBe('+94');
      expect(res.data.customer.phoneNumber).toBe('771234567');
    }
  });
});

// The pay page let a visitor become the customer (spec 2026-08-08). A phone-only quote renders an
// EMPTY surname and email; both are required, both carry autocomplete hints, and Chrome offered
// the operator's saved identity. Four live bookings ended up under the owner's name.
describe('customer identity on the pay page (spec 2026-08-08)', () => {
  const base = {
    firstName: 'Frank', email: 'frank@example.com',
    whatsapp: '+31 641256927', country: 'NL',
  };

  it('accepts a customer with no surname', () => {
    expect(CustomerInput.safeParse(base).success).toBe(true);
    expect(CustomerInput.safeParse({ ...base, lastName: '' }).success).toBe(true);
  });

  it('still demands a first name — someone has to be travelling', () => {
    expect(CustomerInput.safeParse({ ...base, firstName: '' }).success).toBe(false);
  });

  it('still demands a way to reach them', () => {
    expect(CustomerInput.safeParse({ ...base, whatsapp: '' }).success).toBe(false);
  });

  it('keeps the email a real email when one is given', () => {
    expect(CustomerInput.safeParse({ ...base, email: 'not-an-email' }).success).toBe(false);
  });
});
