import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// shared-day.js — the date maths behind "No shared ride on Thu 24 Sep — it runs Wed & Sat"
// (spec 2026-09-19-shared-ride-by-day). Pure: takes ISO dates and weekday numbers, never reads
// the clock, so "today" is an argument and nothing here can rot.
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
let SD;
beforeAll(() => {
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'shared-day.js'), 'utf8'))();
  SD = window.CHSharedDay;
});
const WED_SAT = [3, 6];

describe('runsOn — is this date one of the van\'s days?', () => {
  it('reads the weekday off the calendar date, with no time zone to get wrong', () => {
    expect(SD.runsOn('2099-08-15', WED_SAT)).toBe(true);   // Sat
    expect(SD.runsOn('2099-08-12', WED_SAT)).toBe(true);   // Wed
    expect(SD.runsOn('2099-08-13', WED_SAT)).toBe(false);  // Thu
  });
  it('answers null — not false — when there is no date to judge', () => {
    expect(SD.runsOn('', WED_SAT)).toBeNull();
    expect(SD.runsOn('soon', WED_SAT)).toBeNull();
  });
});

describe('serviceDatesAround — the nearest running day either side of an off-day', () => {
  it('finds the one before and the one after', () => {
    expect(SD.serviceDatesAround('2099-08-13', WED_SAT, '2099-08-01')).toEqual({ before: '2099-08-12', after: '2099-08-15' });
  });
  it('crosses a month boundary', () => {
    expect(SD.serviceDatesAround('2099-08-31', WED_SAT, '2099-08-01')).toEqual({ before: '2099-08-29', after: '2099-09-02' });
  });
  it('never offers a day that is today or already gone', () => {
    expect(SD.serviceDatesAround('2099-08-13', WED_SAT, '2099-08-12').before).toBeNull(); // Wed 12 IS today
    expect(SD.serviceDatesAround('2099-08-13', WED_SAT, '2099-08-11').before).toBe('2099-08-12');
  });
  it('offers nothing for a service with no running days', () => {
    expect(SD.serviceDatesAround('2099-08-13', [], '2099-08-01')).toEqual({ before: null, after: null });
  });
});
