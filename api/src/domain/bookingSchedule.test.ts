import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { scheduleProblem, SCHEDULE_PROBLEMS, SCHEDULE_REASONS, customerScheduleFill } from './bookingSchedule';

// The database CHECK (migration 0075) and this list must agree, or a valid form choice 23514s.
describe('SCHEDULE_REASONS', () => {
  it('is exactly the list the database allows', () => {
    const sql = readFileSync(new URL('../../drizzle/0075_schedule_change_reason_leg_driver_task.sql', import.meta.url), 'utf8');
    const allowed = /"reason" in \(([^)]*)\)/.exec(sql)![1].match(/'([a-z_]+)'/g)!.map((s) => s.slice(1, -1));
    expect([...SCHEDULE_REASONS].sort()).toEqual(allowed.sort());
  });
});

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

describe('customerScheduleFill — the manage page fills blanks only (spec D2)', () => {
  const blank = { date: null, time: null };

  it('fills both blanks', () => {
    expect(customerScheduleFill(blank, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('fills the date and leaves the time for later', () => {
    expect(customerScheduleFill(blank, { date: '2026-11-04', time: null }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: null } });
  });

  it('fills only the time when ops already set the date (sent back unchanged or null)', () => {
    const cur = { date: '2026-11-04', time: null };
    expect(customerScheduleFill(cur, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
    expect(customerScheduleFill(cur, { date: null, time: '09:00' }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('fills the date when only the time was known', () => {
    expect(customerScheduleFill({ date: null, time: '09:00' }, { date: '2026-11-04', time: null }))
      .toEqual({ ok: true, next: { date: '2026-11-04', time: '09:00' } });
  });

  it('never changes a value that is already set', () => {
    expect(customerScheduleFill({ date: '2026-11-04', time: null }, { date: '2026-11-05', time: '09:00' }))
      .toEqual({ ok: false, reason: 'already_set' });
    expect(customerScheduleFill({ date: '2026-11-04', time: '09:00' }, { date: '2026-11-04', time: '10:00' }))
      .toEqual({ ok: false, reason: 'already_set' });
  });

  it('refuses a fill that changes nothing', () => {
    expect(customerScheduleFill({ date: '2026-11-04', time: '09:00' }, { date: '2026-11-04', time: '09:00' }))
      .toEqual({ ok: false, reason: 'nothing_to_set' });
    expect(customerScheduleFill({ date: '2026-11-04', time: null }, { date: null, time: null }))
      .toEqual({ ok: false, reason: 'nothing_to_set' });
  });

  it('needs a date to end up with one (the time alone cannot be stored without it)', () => {
    expect(customerScheduleFill(blank, { date: null, time: '09:00' }))
      .toEqual({ ok: false, reason: 'date_required' });
  });
});
