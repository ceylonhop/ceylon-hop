import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');

// dayGroup/inGroup are pure arrow consts inside ops-ui.html — extract them by source markers
// and eval with their free variables injected, same trick as ops-pay-selection.test.js. The
// test exercises the REAL page code, so the queue's bucketing can never drift from this file.
//
// Why this file exists (team report, 2026-08-06): the classifier had no branch for dates in
// the PAST, so a live-stage booking from last week fell through to "Upcoming" and sat beside
// tomorrow's work forever. Past-dated live bookings are unfinished admin — they get their own
// "Needs closing" bucket, not a place in the future.
//
// Reorganised 2026-09-22 against real prod counts: of 80 queue rows, 32 were past-unclosed and
// 11 were unpaid carts whose travel date had already gone — 54% dead weight, rendered ABOVE the
// 10 rows of actual forward work. The admin piles now have their own filter chips and are out
// of the default list; every DATED booking, paid or not, files under its own travel date.
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

// Anchored to the real clock, per this suite's no-date-bombs rule — the classifiers are pure
// over the injected TODAY/TOMORROW, so nothing here depends on what day the suite runs.
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
const { dayGroup, inGroup } = new Function('CLOSED', 'TODAY', 'TOMORROW', `
  const isExpired=${extractConst('isExpired')};
  const isOverdue=${extractConst('isOverdue')};
  const dayGroup=${extractConst('dayGroup')};
  const inGroup=${extractConst('inGroup')};
  return { dayGroup, inGroup };
`)(CLOSED, TODAY, TOMORROW);

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

  // The change of 2026-09-22. A dated unpaid booking is a TRIP that is coming, and the two most
  // urgent rows in the real queue were exactly this — trip within the week, money not in — filed
  // in a "Pending" block at the very top, as far from their date as the layout could put them.
  it('files a dated unpaid booking under its own travel date, not a Pending pile', () => {
    expect(dayGroup(t({ stage: 'awaiting_payment', date: TODAY }))).toBe('Today');
    expect(dayGroup(t({ stage: 'awaiting_payment', date: TOMORROW }))).toBe('Tomorrow');
    expect(dayGroup(t({ stage: 'awaiting_payment', date: NEXT_MONTH }))).toBe('Upcoming');
  });

  // 11 of the 16 unpaid rows in prod were this: the trip date is gone, so the money can never
  // arrive. They are not "closing" work (there is no trip to mark completed) and not chaseable.
  it('files an unpaid booking whose date has passed under "Expired" — it can never convert', () => {
    expect(dayGroup(t({ stage: 'awaiting_payment', date: LAST_WEEK }))).toBe('Expired');
    expect(dayGroup(t({ stage: 'awaiting_payment', date: YESTERDAY }))).toBe('Expired');
  });

  // 9 prod rows were PAID bookings with no travel date, sitting under a heading that read
  // "awaiting payment · undated". The money is in; what is missing is a date.
  it('files anything undated under "No date yet", paid or not', () => {
    expect(dayGroup(t({ date: null }))).toBe('No date yet');
    expect(dayGroup(t({ stage: 'vehicle_confirmed', date: null }))).toBe('No date yet');
    expect(dayGroup(t({ stage: 'awaiting_payment', date: null }))).toBe('No date yet');
  });

  it('renders the forward timeline first and the admin piles last', () => {
    const m = html.match(/const DAYGROUPS=\[([^\]]*)\]/);
    expect(m, 'DAYGROUPS must exist').toBeTruthy();
    const order = m[1].split(',').map((s) => s.trim().replace(/'/g, ''));
    expect(order).toEqual(['Today', 'Tomorrow', 'Upcoming', 'No date yet', 'Needs closing', 'Expired', 'Closed']);
  });
});

describe('bookings queue filter chips', () => {
  const overdue = t({ date: LAST_WEEK });
  const expired = t({ stage: 'awaiting_payment', date: LAST_WEEK });
  const closed = t({ stage: 'completed', date: LAST_WEEK });

  // The whole point of the reorganisation: the default view is the work, not the residue.
  it('keeps the past piles out of "All open"', () => {
    expect(inGroup(overdue, 'all')).toBe(false);
    expect(inGroup(expired, 'all')).toBe(false);
    expect(inGroup(closed, 'all')).toBe(false);
  });

  it('keeps every live row in "All open", dated or not', () => {
    expect(inGroup(t({ date: TODAY }), 'all')).toBe(true);
    expect(inGroup(t({ date: NEXT_MONTH }), 'all')).toBe(true);
    expect(inGroup(t({ date: null }), 'all')).toBe(true);
    expect(inGroup(t({ stage: 'awaiting_payment', date: TOMORROW }), 'all')).toBe(true);
  });

  it('gives each past pile its own chip, so nothing is hidden — only moved', () => {
    expect(inGroup(overdue, 'closing')).toBe(true);
    expect(inGroup(expired, 'closing')).toBe(false);
    expect(inGroup(expired, 'expired')).toBe(true);
    expect(inGroup(overdue, 'expired')).toBe(false);
    expect(inGroup(closed, 'done')).toBe(true);
  });

  it('scopes the stage chips to live work — a past trip is closing admin, not a vehicle to find', () => {
    expect(inGroup(overdue, 'paid')).toBe(false);
    expect(inGroup(t({ date: TOMORROW }), 'paid')).toBe(true);
    expect(inGroup(expired, 'pay')).toBe(false);
    expect(inGroup(t({ stage: 'awaiting_payment', date: TOMORROW }), 'pay')).toBe(true);
  });

  it('renders a chip for each pile, or the rows would be unreachable', () => {
    const m = html.match(/const GROUPS=\[([\s\S]*?)\];/);
    expect(m, 'GROUPS must exist').toBeTruthy();
    const ids = [...m[1].matchAll(/id:'([a-z]+)'/g)].map((x) => x[1]);
    expect(ids).toContain('closing');
    expect(ids).toContain('expired');
  });

  // The subhead used to count attention across every ticket, closed and expired included —
  // "32 need attention" out of 33 rows says nothing at all. It describes the visible list now.
  it('counts "need attention" over the rows on screen, not every ticket ever', () => {
    expect(html).toContain('${list.filter(t=>isAttn(t)&&!t.test).length} need attention');
  });

  // The nav badge has to count the same rows the list shows, or it points somewhere the reader
  // cannot get to. Against the real queue the unscoped version read ~60 for a forward book of 10.
  it('scopes the nav badge to open work', () => {
    expect(html).toContain("const attn=tickets.filter(t=>inGroup(t,'all')&&isAttn(t)&&!t.test).length;");
  });
});
