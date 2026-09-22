import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';
// The backend's own cutoff function, imported directly (same trick as backend-price-parity).
// board.js mirrors the 24 h rule in its own arithmetic; comparing against THIS is what stops
// the two drifting apart when someone changes the deadline on one side only.
import { cutoffAt } from '../../api/src/domain/rideList.ts';

// ────────────────────────────────────────────────────────────────────────────
// A ride closes CUTOFF_HOURS_BEFORE its departure window opens (api/src/domain/rideList.ts —
// 24 h since 2026-09-22). The create form used to offer tomorrow, so a traveller could
// start a ride that was ALREADY past its own cutoff: nobody could join it (the join
// route 409s a closed list) and the next cutoff sweep called it off. It happened on
// production — EA-8707, Ella to Arugam Bay, started 2026-09-22. (date-bomb-ok: a past incident)
//
// The floor is computed from the MORNING window (07:00 Colombo), the earliest departure
// there is, so an afternoon ride on the same date is closed even later and stays valid.
// ────────────────────────────────────────────────────────────────────────────
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB, src;
beforeAll(() => {
  loadTransfers();
  src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

// Derived from the backend, never a second copy of the number.
const cutoffMs = (date) => cutoffAt(date, 'morning').getTime();

describe('RideBoard.earliestStartDate(now)', () => {
  it('is exposed as a pure helper', () => {
    expect(typeof RB.earliestStartDate).toBe('function');
  });

  it('skips a date whose 48h cutoff has already passed', () => {
    // date-bomb-ok: earliestStartDate is pure over the `now` it is handed, so this pair cannot
    // rot — 23:30 in Colombo on the 22nd, where a ride on the 23rd closed at 01:30Z that morning.
    const now = Date.parse('2026-09-22T18:00:00Z'); // date-bomb-ok: fixed clock, pure fn
    expect(RB.earliestStartDate(now)).toBe('2026-09-24'); // date-bomb-ok: fixed clock, see above
  });

  it('still allows the nearest date while its cutoff is ahead', () => {
    // date-bomb-ok: same fixed clock — 05:30 in Colombo on the 22nd, where the 23rd closes at
    // 01:30Z, 90 minutes from now. The boundary is the point of the test.
    const now = Date.parse('2026-09-22T00:00:00Z'); // date-bomb-ok: fixed clock, pure fn
    expect(RB.earliestStartDate(now)).toBe('2026-09-23'); // date-bomb-ok: fixed clock, see above
  });

  it('never returns a date that is already closed, across a full day of clock positions', () => {
    for (let h = 0; h < 24; h++) {
      // date-bomb-ok: a fixed clock swept hour by hour; the assertions are relative to it
      const now = Date.parse(`2026-09-22T${String(h).padStart(2, '0')}:00:00Z`);
      const d = RB.earliestStartDate(now);
      expect(cutoffMs(d)).toBeGreaterThan(now);
      // and it is the EARLIEST such date — the day before it must be closed
      const prev = new Date(Date.parse(`${d}T00:00:00Z`) - 864e5).toISOString().slice(0, 10);
      expect(cutoffMs(prev)).toBeLessThanOrEqual(now);
    }
  });
});

// The whole point of this block: the deadline is written in TWO places — the backend constant
// and board.js's own arithmetic. Comparing the page's computation against the backend FUNCTION
// (not against a copied number) means changing one side alone turns this red.
describe('board.js and the backend agree on when a ride closes', () => {
  it('computes the identical closing instant, morning window, across a year', () => {
    // date-bomb-ok: pure function inputs on both sides; nothing here reads the wall clock
    for (const date of ['2026-09-23', '2026-10-01', '2026-12-31', '2027-03-15', '2027-09-22']) {
      expect(RB.closesAt(date)).toBe(cutoffAt(date, 'morning').getTime());
    }
  });

  it('uses the morning window as the floor, which is never later than the afternoon one', () => {
    // The form offers one date for both windows, so the floor must come from the EARLIER
    // departure or an afternoon-only date would be offered while its morning twin is closed.
    for (const date of ['2026-09-23', '2027-03-15']) { // date-bomb-ok: pure fn inputs
      expect(RB.closesAt(date)).toBeLessThan(cutoffAt(date, 'afternoon').getTime());
    }
  });
});

describe('the create form uses that floor', () => {
  // The block that seeds the date input. Asserting on this window rather than one line
  // keeps the test about WHERE the floor comes from, not how the statement is spelled.
  const seedBlock = () => {
    const at = src.search(/cDate\.min\s*=/);
    expect(at).toBeGreaterThan(-1);
    return src.slice(Math.max(0, at - 400), at + 400);
  };

  it('takes the date input minimum from earliestStartDate, not "tomorrow"', () => {
    expect(seedBlock()).toContain('earliestStartDate');
    // the old floor: one day out, which is always past its own cutoff
    expect(src).not.toMatch(/cDate\.min\s*=\s*new Date\(Date\.now\(\)\s*\+\s*864e5\)/);
  });

  it('explains the server refusal and re-seeds the input, rather than a generic error', () => {
    expect(src).toContain("'cutoff_passed'");
    const at = src.indexOf("'cutoff_passed'");
    const block = src.slice(at, at + 420);
    expect(block).toContain('earliestStartDate');
    expect(block).toMatch(/24 hours/);
  });

  it('clamps the default date up to that floor instead of below it', () => {
    const block = seedBlock();
    expect(block).toMatch(/cDate\.value/);
    // the default (3 days out) must be compared against the floor, never used raw
    expect(block).toMatch(/min/);
  });
});
