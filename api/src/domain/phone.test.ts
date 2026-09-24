import { describe, it, expect } from 'vitest';
import { digitsOf, isInternationalNumber, INTERNATIONAL_NUMBER_RULE } from './phone';

// One rule for every phone box the API accepts. CH-T74DT (website, 2026-08-27) banked a
// 26-digit WhatsApp number because CustomerInput checked for presence only; the Ride Board's
// payment.phone had the same hole (length 5–32, any characters). The check reads the DIGITS —
// people type "+94 77 123 4567" — and the value itself is stored as sent.
describe('phone: the international-number rule', () => {
  it('digitsOf drops the spaces, dashes, dots and brackets people type, keeping + and digits', () => {
    expect(digitsOf('+44 (0)7700-900.123')).toBe('+4407700900123');
    expect(digitsOf('+94771234567')).toBe('+94771234567');
  });

  it('accepts + followed by 6–15 digits, however it is punctuated', () => {
    expect(isInternationalNumber('+947712')).toBe(true); // 6 digits — the floor
    expect(isInternationalNumber('+94771234567')).toBe(true);
    expect(isInternationalNumber('+123456789012345')).toBe(true); // 15 digits — the E.164 ceiling
    expect(isInternationalNumber('+94 77 123 4567')).toBe(true);
    expect(isInternationalNumber('+31.6.4125.6927')).toBe(true);
  });

  it('rejects too few digits, too many, a missing +, letters, or nothing at all', () => {
    expect(isInternationalNumber('+94771')).toBe(false); // 5 digits
    expect(isInternationalNumber('+1234567890123456')).toBe(false); // 16 digits
    expect(isInternationalNumber('+94123134124123412312312312')).toBe(false); // CH-T74DT, 26 digits
    expect(isInternationalNumber('94771234567')).toBe(false); // no +
    expect(isInternationalNumber('+94abc1234')).toBe(false);
    expect(isInternationalNumber('')).toBe(false);
  });

  it('words the rule the way the booker and pay page already show it', () => {
    expect(INTERNATIONAL_NUMBER_RULE).toMatch(/6.15 digits/);
    expect(INTERNATIONAL_NUMBER_RULE).toMatch(/\+94771234567/);
  });
});
