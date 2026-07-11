import { describe, it, expect } from 'vitest';
import { isoToday, isPastIsoDate, firstPastDate, isoWeekday, serviceDaysLabel } from './dateRules';

describe('isoToday', () => {
  it('formats the given instant as YYYY-MM-DD in the target timezone', () => {
    // 2026-07-09 20:00 UTC is 2026-07-10 01:30 in Asia/Colombo (UTC+5:30)
    const at = new Date('2026-07-09T20:00:00Z');
    expect(isoToday('Asia/Colombo', at)).toBe('2026-07-10');
    expect(isoToday('UTC', at)).toBe('2026-07-09');
  });
});

describe('isPastIsoDate', () => {
  const today = '2026-07-09';
  it('true only for a valid ISO date strictly before today', () => {
    expect(isPastIsoDate('2026-07-08', today)).toBe(true);
    expect(isPastIsoDate('2020-01-01', today)).toBe(true);
  });
  it('false for today and future', () => {
    expect(isPastIsoDate('2026-07-09', today)).toBe(false);
    expect(isPastIsoDate('2026-07-10', today)).toBe(false);
  });
  it('false for absent or non-ISO values (flexible / "to confirm" are not past)', () => {
    expect(isPastIsoDate(undefined, today)).toBe(false);
    expect(isPastIsoDate(null, today)).toBe(false);
    expect(isPastIsoDate('', today)).toBe(false);
    expect(isPastIsoDate('to confirm', today)).toBe(false);
    expect(isPastIsoDate('2026/07/08', today)).toBe(false); // not ISO — left alone
  });
});

describe('firstPastDate', () => {
  const today = '2026-07-09';
  it('returns the first past date, or null when none', () => {
    expect(firstPastDate(['2026-07-10', '2026-07-08', '2020-01-01'], today)).toBe('2026-07-08');
    expect(firstPastDate(['2026-07-10', undefined, ''], today)).toBe(null);
    expect(firstPastDate([], today)).toBe(null);
  });
});

describe('isoWeekday', () => {
  it('returns the calendar weekday as 0=Sun … 6=Sat', () => {
    expect(isoWeekday('2026-07-22')).toBe(3); // Wednesday
    expect(isoWeekday('2026-07-25')).toBe(6); // Saturday
    expect(isoWeekday('2026-07-20')).toBe(1); // Monday
    expect(isoWeekday('2026-07-19')).toBe(0); // Sunday
  });
  it('is timezone-independent — a calendar date has one weekday regardless of server TZ', () => {
    const saved = process.env.TZ;
    try {
      process.env.TZ = 'Pacific/Kiritimati'; // UTC+14
      expect(isoWeekday('2026-07-22')).toBe(3);
      process.env.TZ = 'Pacific/Pago_Pago'; // UTC-11
      expect(isoWeekday('2026-07-22')).toBe(3);
    } finally {
      process.env.TZ = saved;
    }
  });
  it('returns null for absent or non-ISO values', () => {
    expect(isoWeekday(undefined)).toBe(null);
    expect(isoWeekday(null)).toBe(null);
    expect(isoWeekday('')).toBe(null);
    expect(isoWeekday('to confirm')).toBe(null);
    expect(isoWeekday('2026/07/22')).toBe(null);
  });
});

describe('serviceDaysLabel', () => {
  it('renders a human list of weekday names', () => {
    expect(serviceDaysLabel([3, 6])).toBe('Wed & Sat');
    expect(serviceDaysLabel([6, 3])).toBe('Wed & Sat'); // sorted
    expect(serviceDaysLabel([1, 3, 5])).toBe('Mon, Wed & Fri');
    expect(serviceDaysLabel([3])).toBe('Wed');
  });
});
