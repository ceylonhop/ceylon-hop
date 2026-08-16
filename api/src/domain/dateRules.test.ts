import { describe, it, expect } from 'vitest';
import {
  isoToday,
  isPastIsoDate,
  firstPastDate,
  isoWeekday,
  serviceDaysLabel,
  addIsoDays,
  earliestChauffeurDate,
  isTooSoonPrivate,
  isTooSoonChauffeur,
  PRIVATE_MIN_LEAD_HOURS,
  CHAUFFEUR_MIN_LEAD_DAYS,
} from './dateRules';

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

// Minimum notice (owner rule, 2026-08-16). 09:30 Colombo on 2026-08-16 is the fixed "now" for
// every case below, so the arithmetic is readable rather than relative.
const NOW = new Date('2026-08-16T04:00:00Z');

describe('addIsoDays', () => {
  it('walks the calendar, crossing month and year ends', () => {
    expect(addIsoDays('2026-08-16', 7)).toBe('2026-08-23');
    expect(addIsoDays('2026-08-28', 7)).toBe('2026-09-04');
    expect(addIsoDays('2026-12-30', 7)).toBe('2027-01-06');
  });
});

describe('isTooSoonPrivate', () => {
  it('rejects a pickup less than 12 hours away', () => {
    expect(PRIVATE_MIN_LEAD_HOURS).toBe(12);
    // 18:00 Colombo today is 8.5 hours after 09:30.
    expect(isTooSoonPrivate('2026-08-16', '18:00', NOW)).toBe(true);
    // 21:00 today is 11.5 hours — still short.
    expect(isTooSoonPrivate('2026-08-16', '21:00', NOW)).toBe(true);
  });

  it('accepts a pickup 12 hours away or more', () => {
    expect(isTooSoonPrivate('2026-08-16', '21:30', NOW)).toBe(false); // exactly 12h
    expect(isTooSoonPrivate('2026-08-16', '23:00', NOW)).toBe(false);
    expect(isTooSoonPrivate('2026-08-17', '06:00', NOW)).toBe(false);
  });

  it('falls back to the calendar floor when no time was given (flexi-time)', () => {
    // Without an hour there is nothing to measure, so the rule becomes "not today": ops confirm
    // the time later, and the earliest that day could start is already behind us.
    expect(isTooSoonPrivate('2026-08-16', undefined, NOW)).toBe(true);
    expect(isTooSoonPrivate('2026-08-16', '', NOW)).toBe(true);
    expect(isTooSoonPrivate('2026-08-17', undefined, NOW)).toBe(false);
  });

  it('leaves absent, non-ISO and unparseable values alone (flexible is not too soon)', () => {
    expect(isTooSoonPrivate(undefined, '09:00', NOW)).toBe(false);
    expect(isTooSoonPrivate('', undefined, NOW)).toBe(false);
    expect(isTooSoonPrivate('to confirm', undefined, NOW)).toBe(false);
    expect(isTooSoonPrivate('2026/08/17', '09:00', NOW)).toBe(false);
    // A junk time is treated as no time at all, not as a reason to reject a fine date.
    expect(isTooSoonPrivate('2026-08-17', 'morning', NOW)).toBe(false);
  });
});

describe('earliestChauffeurDate / isTooSoonChauffeur', () => {
  it('is 7 days out, in Asia/Colombo', () => {
    expect(CHAUFFEUR_MIN_LEAD_DAYS).toBe(7);
    expect(earliestChauffeurDate(NOW)).toBe('2026-08-23');
    // 20:00 UTC is already tomorrow in Colombo, so the floor moves with the Colombo day.
    expect(earliestChauffeurDate(new Date('2026-08-16T20:00:00Z'))).toBe('2026-08-24');
  });

  it('rejects a trip starting inside the window and accepts one on the boundary', () => {
    expect(isTooSoonChauffeur(['2026-08-22'], NOW)).toBe(true);
    expect(isTooSoonChauffeur(['2026-08-23'], NOW)).toBe(false);
    expect(isTooSoonChauffeur(['2026-08-30'], NOW)).toBe(false);
  });

  it('judges the EARLIEST date, wherever it sits in the list', () => {
    // A chauffeur commits the car from the first day, so a late first entry still binds.
    expect(isTooSoonChauffeur(['2026-08-30', '2026-08-22'], NOW)).toBe(true);
  });

  it('leaves undated and flexible trips alone', () => {
    expect(isTooSoonChauffeur([], NOW)).toBe(false);
    expect(isTooSoonChauffeur(['to confirm', ''], NOW)).toBe(false);
    expect(isTooSoonChauffeur([undefined, null], NOW)).toBe(false);
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
