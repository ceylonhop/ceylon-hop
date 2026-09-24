// The one phone rule, shared by every box the API accepts a number in. CH-T74DT (website,
// 2026-08-27) banked a 26-digit WhatsApp number because the customer schema checked for
// presence only, and the Ride Board's payment.phone had the same hole (5–32 characters of
// anything). E.164 caps a full number at 15 digits; the floor keeps out "+1".
//
// The check reads the DIGITS — people type "+94 77 123 4567" and the ops quote tool posts its
// WhatsApp box exactly as typed — but the value itself is stored as sent: validation, not
// normalisation (the wa.me links already strip for themselves).

// What people type around the digits — "+94 77 123 4567", "077-123-4567", "+44 (0)7700 900123".
const PHONE_PUNCTUATION = /[\s\-().]/g;
export const digitsOf = (v: string) => v.replace(PHONE_PUNCTUATION, '');

export const INTERNATIONAL_NUMBER = /^\+\d{6,15}$/;
export const isInternationalNumber = (v: string) => INTERNATIONAL_NUMBER.test(digitsOf(v));

// Names the rule and an example, the way the booker's overlay and pay.html already show it.
export const INTERNATIONAL_NUMBER_RULE = 'Phone number must be + followed by 6–15 digits (e.g. +94771234567)';

// The customer schema's two display-only parts: a dial code (checked as typed — E.164 caps it at
// 3 digits) and a national number (checked on its digits; the floor keeps out "123").
export const DIAL_CODE = /^\+\d{1,3}$/;
export const NATIONAL_NUMBER = /^\d{4,15}$/;
