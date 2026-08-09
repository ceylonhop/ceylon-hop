import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// dayGroup is a pure arrow const inside ops-ui.html — extract it by source markers and eval
// with its three free variables injected, same trick as ops-pay-selection.test.js. The test
// exercises the REAL page code, so the queue's day-bucketing can never drift from this file.
//
// Why this file exists (team report, 2026-08-06): the classifier had no branch for dates in
// the PAST, so a live-stage booking from last week fell through to "Upcoming" and sat beside
// tomorrow's work forever. Past-dated live bookings are unfinished admin — they get their own
// "Needs closing" bucket, not a place in the future.
function extractConst(name) {
  const start = html.indexOf(`const ${name}=`);
  if (start < 0) throw new Error(`const ${name} not found in ops-ui.html`);
  const open = html.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < html.length; i++) {
    if (html[i] === '{') depth++;
    if (html[i] === '}') depth--;
    if (depth === 0) break;
  }
  return html.slice(html.indexOf('=', start) + 1, i + 1);
}

// Anchored to the real clock, per this suite's no-date-bombs rule — dayGroup is pure over the
// injected TODAY/TOMORROW, so nothing here depends on what day the suite runs.
const CLOSED = ['completed', 'no_show', 'cancelled', 'refunded'];
const iso = (offsetDays) => {
  const d = new Date(Date.now() + offsetDays * 86_400_000);
  return d.toISOString().slice(0, 10);
};
const TODAY = iso(0);
const TOMORROW = iso(1);
const LAST_WEEK = iso(-7);
const YESTERDAY = iso(-1);
const NEXT_MONTH = iso(20);
// eslint-disable-next-line no-new-func
const dayGroup = new Function('CLOSED', 'TODAY', 'TOMORROW',
  'return (' + extractConst('dayGroup') + ')')(CLOSED, TODAY, TOMORROW);

const t = (over) => ({ stage: 'paid', date: NEXT_MONTH, source: 'web', ...over });

describe('bookings queue day groups', () => {
  it('files a live-stage booking whose date has passed under "Needs closing" — never "Upcoming"', () => {
    expect(dayGroup(t({ date: LAST_WEEK }))).toBe('Needs closing');
    expect(dayGroup(t({ stage: 'vehicle_confirmed', date: YESTERDAY }))).toBe('Needs closing');
    expect(dayGroup(t({ stage: 'on_trip', date: LAST_WEEK }))).toBe('Needs closing');
  });

  it('keeps today, tomorrow and the future where they were', () => {
    expect(dayGroup(t({ date: TODAY }))).toBe('Today');
    expect(dayGroup(t({ date: TOMORROW }))).toBe('Tomorrow');
    expect(dayGroup(t({ date: NEXT_MONTH }))).toBe('Upcoming');
  });

  it('closed outcomes stay Closed whatever their date — a dead booking is not admin work', () => {
    expect(dayGroup(t({ stage: 'cancelled', date: LAST_WEEK }))).toBe('Closed');
    expect(dayGroup(t({ stage: 'completed', date: LAST_WEEK }))).toBe('Closed');
  });

  it('awaiting payment stays Pending even when dated in the past — its action is money, not closing', () => {
    expect(dayGroup(t({ stage: 'awaiting_payment', date: LAST_WEEK }))).toBe('Pending');
    expect(dayGroup(t({ date: null }))).toBe('Pending');
  });

  it('the section order shows Needs closing between Tomorrow and Upcoming', () => {
    const m = html.match(/const DAYGROUPS=\[([^\]]*)\]/);
    expect(m, 'DAYGROUPS must exist').toBeTruthy();
    const order = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(order).toEqual(['Pending', 'Today', 'Tomorrow', 'Needs closing', 'Upcoming', 'Closed']);
  });
});
