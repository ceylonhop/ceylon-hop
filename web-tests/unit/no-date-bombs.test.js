import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { futureIsoDate, nextIsoWeekday, isoToSummary, isoParts } from '../dates.js';

/* A hard-coded calendar date in the near future is a time bomb: booking and ops both reject past
   dates, so the suite stays green until the wall clock passes the literal and then the SAME commit
   goes red with no code change. That is exactly what happened here — literals dated 2026-08-0x
   were due to start failing ~2026-08-08 (docs/known-bugs.md, 2026-07-25).
   Use ../dates.js (futureIsoDate / nextIsoWeekday) instead, so dates are anchored to "now".

   Only the ROTTING window is banned. Deliberately past dates are fine (a stale-link test wants
   2020-01-01, and `rateCardVersion: '2026-07-09'` is a version string that merely looks like a
   date). Far-future sentinels are fine too — nobody is running this suite in 2099. */

// vitest runs with cwd = web-tests/ (see vitest.config.js); the jsdom environment does not
// give this module a file: import.meta.url, so resolve from cwd rather than the module URL.
const ROOT = process.cwd();
const DATE_RE = /['"`](\d{4}-\d{2}-\d{2})(?:T[\d:.]+Z?)?['"`]/g;
const HORIZON_MONTHS = 18;

function specFiles() {
  const out = [];
  for (const dir of ['e2e', 'unit']) {
    for (const name of readdirSync(join(ROOT, dir))) {
      if (name.endsWith('.js')) out.push(join(dir, name));
    }
  }
  return out;
}

describe('no date bombs in the web test suite', () => {
  it('has no hard-coded calendar date inside the rotting window', () => {
    const today = new Date();
    const horizon = new Date(today);
    horizon.setUTCMonth(horizon.getUTCMonth() + HORIZON_MONTHS);
    const todayIso = today.toISOString().slice(0, 10);
    const horizonIso = horizon.toISOString().slice(0, 10);

    const offenders = [];
    for (const rel of specFiles()) {
      if (rel.endsWith('no-date-bombs.test.js')) continue; // the ISO strings above are the subject
      const text = readFileSync(join(ROOT, rel), 'utf8');
      const lines = text.split('\n');
      lines.forEach((line, i) => {
        // Narrow, per-line opt-out for a date that genuinely cannot rot — e.g. the input to a
        // PURE formatter, paired with a literal expected string. Deriving that expectation
        // dynamically would just re-implement the formatter and assert nothing. Requires a
        // reason on the same line, so it stays reviewable.
        // …on the line itself, or on the line above it when the statement is too long to carry it.
        if (line.includes('date-bomb-ok') || (lines[i - 1] || '').includes('date-bomb-ok')) return;
        for (const m of line.matchAll(DATE_RE)) {
          const iso = m[1];
          if (iso >= todayIso && iso <= horizonIso) {
            offenders.push(`${rel}:${i + 1}  ${iso}`);
          }
        }
      });
    }

    expect(
      offenders,
      `Hard-coded dates between ${todayIso} and ${horizonIso} will rot into the past and turn this\n`
      + `suite red on their own. Anchor them to now with futureIsoDate()/nextIsoWeekday() from\n`
      + `web-tests/dates.js instead:\n  ${offenders.join('\n  ')}\n`,
    ).toEqual([]);
  });
});

/* The helpers themselves — new code, and the arithmetic has to survive month and year rollover
   (the whole point is that these run on an arbitrary future day). */
describe('dates.js helpers', () => {
  const ISO = /^\d{4}-\d{2}-\d{2}$/;
  const todayIso = new Date().toISOString().slice(0, 10);

  it('futureIsoDate returns a well-formed ISO date that is always in the future', () => {
    for (const n of [1, 7, 30, 45, 220, 400]) {
      const iso = futureIsoDate(n);
      expect(iso).toMatch(ISO);
      expect(iso > todayIso, `${iso} should be after ${todayIso}`).toBe(true);
    }
  });

  it('futureIsoDate keeps offsets in order and lands the right number of days out', () => {
    expect(futureIsoDate(30) < futureIsoDate(31)).toBe(true);
    expect(futureIsoDate(31) < futureIsoDate(40)).toBe(true);
    const a = Date.parse(futureIsoDate(30) + 'T00:00:00Z');
    const b = Date.parse(futureIsoDate(40) + 'T00:00:00Z');
    expect((b - a) / 86400000).toBe(10); // survives month/year rollover
  });

  it('nextIsoWeekday lands on the asked-for weekday, at least minDaysAhead out', () => {
    for (const wd of [0, 3, 6]) { // Sun, Wed, Sat — Wed/Sat are the shared-ride service days
      const iso = nextIsoWeekday(wd, 14);
      expect(iso).toMatch(ISO);
      expect(new Date(iso + 'T00:00:00Z').getUTCDay()).toBe(wd);
      expect((Date.parse(iso + 'T00:00:00Z') - Date.parse(todayIso + 'T00:00:00Z')) / 86400000)
        .toBeGreaterThanOrEqual(14);
    }
  });

  it('isoParts/isoToSummary describe the same day the ISO string names', () => {
    expect(isoParts('2026-08-18')).toEqual({ year: 2026, monthIndex: 7, day: 18 }); // date-bomb-ok: pure parser input
    expect(isoToSummary('2026-08-18')).toBe('18 Aug 2026'); // date-bomb-ok: pure formatter input
    expect(isoToSummary('2027-01-01')).toBe('1 Jan 2027'); // date-bomb-ok: pure formatter input
  });
});
