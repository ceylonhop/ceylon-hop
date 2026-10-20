import { describe, it, expect } from 'vitest';
import { scheduleProblem, SCHEDULE_PROBLEMS } from './bookingSchedule';

// 06:00Z = 11:30 in Colombo on 2026-10-17.
const NOW = new Date('2026-10-17T06:00:00Z');

describe('scheduleProblem', () => {
  it('accepts a future date with a time, and one without', () => {
    expect(scheduleProblem('2026-10-18', '09:00', NOW)).toBeNull();
    expect(scheduleProblem('2026-10-20', null, NOW)).toBeNull();
  });

  it('rejects malformed or impossible dates and times', () => {
    expect(scheduleProblem('18/10/2026', null, NOW)).toBe('bad_date');
    expect(scheduleProblem('2026-02-30', null, NOW)).toBe('bad_date');
    expect(scheduleProblem('2026-10-20', '9am', NOW)).toBe('bad_time');
    expect(scheduleProblem('2026-10-20', '24:00', NOW)).toBe('bad_time');
  });

  it('rejects a date that has passed in Colombo', () => {
    expect(scheduleProblem('2026-10-16', '09:00', NOW)).toBe('past');
  });

  it('applies the 12-hour notice rule, and refuses today without a time', () => {
    expect(scheduleProblem('2026-10-17', '20:00', NOW)).toBe('too_soon'); // 8.5 h away
    expect(scheduleProblem('2026-10-17', null, NOW)).toBe('too_soon');
  });

  it('lets ops waive the notice rule, but never accept a past date', () => {
    expect(scheduleProblem('2026-10-17', '20:00', NOW, { allowShortNotice: true })).toBeNull();
    expect(scheduleProblem('2026-10-16', '09:00', NOW, { allowShortNotice: true })).toBe('past');
  });

  it('allows up to 12 months ahead and no further (booking.js maxBookDate)', () => {
    expect(scheduleProblem('2027-10-17', null, NOW)).toBeNull();
    expect(scheduleProblem('2027-10-18', null, NOW)).toBe('too_far');
  });

  it('names every problem it can return', () => {
    expect([...SCHEDULE_PROBLEMS]).toEqual(['bad_date', 'bad_time', 'past', 'too_soon', 'too_far']);
  });
});
