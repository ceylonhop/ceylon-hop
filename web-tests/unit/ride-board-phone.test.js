import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// ────────────────────────────────────────────────────────────────────────────
// The ride board's phone bound (2026-09-24).
//
// #761 made the API refuse a board number that is not + then 6–15 digits
// (400 phone_invalid); CH-T74DT had banked a 26-digit WhatsApp number through
// a box that checked presence only. joinedPhone() only ever sends '+' + digits,
// so the page can hold the same line itself and refuse BEFORE the PayHere
// hand-off screen goes up. The API stays the backstop. These pin the edges to
// the API's own floor and cap.
// ────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  const src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

describe('RideBoard.isInternationalNumber(phone)', () => {
  it('is exposed, and takes what joinedPhone() sends for a real number', () => {
    expect(typeof RB.isInternationalNumber).toBe('function');
    expect(RB.isInternationalNumber('+447700900123')).toBe(true);
    expect(RB.isInternationalNumber('+94771234567')).toBe(true);
  });

  it("takes exactly 6 and exactly 15 digits, the API's floor and cap", () => {
    expect(RB.isInternationalNumber('+123456')).toBe(true);
    expect(RB.isInternationalNumber('+123456789012345')).toBe(true);
  });

  it('refuses 5 digits and 16 digits', () => {
    expect(RB.isInternationalNumber('+94771')).toBe(false);
    expect(RB.isInternationalNumber('+1234567890123456')).toBe(false);
  });

  it('refuses the CH-T74DT number (26 digits)', () => {
    expect(RB.isInternationalNumber('+94123134124123412312312312')).toBe(false);
  });

  it('refuses anything that is not + then digits', () => {
    expect(RB.isInternationalNumber('94771234567')).toBe(false);
    expect(RB.isInternationalNumber('+94abc1234')).toBe(false);
    expect(RB.isInternationalNumber('+')).toBe(false);
    expect(RB.isInternationalNumber('')).toBe(false);
    expect(RB.isInternationalNumber(null)).toBe(false);
    expect(RB.isInternationalNumber(undefined)).toBe(false);
  });
});
