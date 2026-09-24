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

// Prod booking CH-T74DT (website, 2026-08-27) was created with whatsapp
// '+94123134124123412312312312' — 26 digits — and phone_number '123134124123412312312312',
// under the name "dsad sdax". All three create routes took it: the schema bounded neither the
// length nor the shape of any phone field. E.164 caps a full number at 15 digits and a country
// code at 3. The rule reads the DIGITS: people type "+94 77 123 4567", and the ops quote tool's
// WhatsApp box is posted exactly as typed (its placeholder even suggests spaces), so common
// punctuation is ignored for the check. The value is stored as sent — validation, not
// normalisation.
describe('customer phone fields are bounded (CH-T74DT, 2026-08-27)', () => {
  const base = { firstName: 'Maya', email: 'maya@example.com', whatsapp: '+94771234567', country: 'Sri Lanka' };
  const ok = (over: Record<string, unknown>) => CustomerInput.safeParse({ ...base, ...over }).success;
  const firstIssue = (over: Record<string, unknown>) => {
    const res = CustomerInput.safeParse({ ...base, ...over });
    return res.success ? null : res.error.issues[0];
  };

  it('refuses the CH-T74DT payload — a 26-digit WhatsApp number and a 24-digit phone number', () => {
    expect(ok({ whatsapp: '+94123134124123412312312312' })).toBe(false);
    expect(ok({ phoneNumber: '123134124123412312312312' })).toBe(false);
  });

  describe('whatsapp: + followed by 6–15 digits', () => {
    it('accepts real international numbers, short and long', () => {
      expect(ok({ whatsapp: '+947712' })).toBe(true); // 6 digits — the floor
      expect(ok({ whatsapp: '+94771234567' })).toBe(true);
      expect(ok({ whatsapp: '+123456789012345' })).toBe(true); // 15 digits — the E.164 ceiling
    });

    it('rejects too few digits, too many, a missing +, or letters', () => {
      expect(ok({ whatsapp: '+94771' })).toBe(false); // 5 digits
      expect(ok({ whatsapp: '+1234567890123456' })).toBe(false); // 16 digits
      expect(ok({ whatsapp: '94771234567' })).toBe(false); // no +
      expect(ok({ whatsapp: '+94abc1234' })).toBe(false);
    });

    it('ignores the spaces, dashes, dots and brackets people type — the ops WhatsApp box is posted as typed', () => {
      expect(ok({ whatsapp: '+94 77 123 4567' })).toBe(true);
      expect(ok({ whatsapp: '+44-7700-900123' })).toBe(true);
      expect(ok({ whatsapp: '+44 (0)7700 900123' })).toBe(true);
      expect(ok({ whatsapp: '+31.6.4125.6927' })).toBe(true);
    });

    it('keeps the value as sent — validation, not normalisation', () => {
      const res = CustomerInput.safeParse({ ...base, whatsapp: '+94 77 123 4567' });
      expect(res.success && res.data.whatsapp).toBe('+94 77 123 4567');
    });

    it('names the field and the rule, so the overlay / ops toast can say what to fix', () => {
      const issue = firstIssue({ whatsapp: '+94123134124123412312312312' });
      expect(issue?.path).toEqual(['whatsapp']);
      expect(issue?.message).toMatch(/6.15 digits/);
    });
  });

  describe('phoneNumber: 4–15 digits once formatting is dropped', () => {
    it('accepts 4 to 15 digits, with or without the usual separators', () => {
      expect(ok({ phoneNumber: '1234' })).toBe(true);
      expect(ok({ phoneNumber: '771234567' })).toBe(true);
      expect(ok({ phoneNumber: '123456789012345' })).toBe(true);
      expect(ok({ phoneNumber: '077 123 4567' })).toBe(true);
      expect(ok({ phoneNumber: '077-123-4567' })).toBe(true);
    });

    it('rejects 3 digits, 16 digits, or letters', () => {
      expect(ok({ phoneNumber: '123' })).toBe(false);
      expect(ok({ phoneNumber: '1234567890123456' })).toBe(false);
      expect(ok({ phoneNumber: '77abc4567' })).toBe(false);
    });

    it('still reads "" as not provided (the booker emits it for an unknown dial code)', () => {
      const res = CustomerInput.safeParse({ ...base, phoneNumber: '', phoneCountryCode: '' });
      expect(res.success).toBe(true);
      expect(res.success && res.data.phoneNumber).toBeUndefined();
    });
  });

  describe('phoneCountryCode: + followed by 1–3 digits', () => {
    it('accepts every real country-code length', () => {
      expect(ok({ phoneCountryCode: '+1' })).toBe(true);
      expect(ok({ phoneCountryCode: '+94' })).toBe(true);
      expect(ok({ phoneCountryCode: '+358' })).toBe(true);
    });

    it('rejects a missing +, four digits, or letters', () => {
      expect(ok({ phoneCountryCode: '94' })).toBe(false);
      expect(ok({ phoneCountryCode: '+1234' })).toBe(false);
      expect(ok({ phoneCountryCode: '+9a' })).toBe(false);
    });
  });
});
