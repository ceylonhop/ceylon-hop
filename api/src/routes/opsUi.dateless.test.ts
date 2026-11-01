import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// Dateless booking capture, Phase 3 (spec 2026-10-17 §5): the queue says how long an undated
// booking has waited since the money landed, and flags a dated private transfer with no pickup
// time. The shell is one inlined script, so the pure helpers are lifted out and table-tested,
// and the row wiring is pinned by source.

let body: string;

function liftConst(src: string, name: string): string {
  const start = src.indexOf(`const ${name}=`);
  expect(start, `${name} not found in the ops shell`).toBeGreaterThan(-1);
  let depth = 0;
  for (let i = start; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{' || ch === '(' || ch === '[') depth++;
    else if (ch === '}' || ch === ')' || ch === ']') depth--;
    else if (ch === ';' && depth === 0) return src.slice(start, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
});

const TODAY = '2026-10-18';
type Cue = { txt: string; late: boolean } | null;
function helpers() {
  const src = ['_pad', 'isoOf', 'CLOSED', 'isBoard', 'paidAgo', 'timeTbc'].map((n) => liftConst(body, n)).join(' ');
  return new Function('TODAY', `${src}; return { paidAgo, timeTbc };`)(TODAY) as {
    paidAgo: (t: unknown) => Cue; timeTbc: (t: unknown) => boolean;
  };
}

// Midday UTC, so the local calendar day is the same wherever the suite runs.
const paidOn = (iso: string) => ({ source: 'booking', paid: true, paidAt: `${iso}T06:00:00Z` });

describe('paidAgo() — days since the money landed', () => {
  it('counts calendar days', () => {
    expect(helpers().paidAgo(paidOn('2026-10-18'))).toEqual({ txt: 'paid today', late: false });
    expect(helpers().paidAgo(paidOn('2026-10-17'))).toEqual({ txt: 'paid 1 day ago', late: false });
    expect(helpers().paidAgo(paidOn('2026-10-12'))).toEqual({ txt: 'paid 6 days ago', late: false });
  });
  it('turns late at 7 days', () => {
    expect(helpers().paidAgo(paidOn('2026-10-11'))).toEqual({ txt: 'paid 7 days ago', late: true });
    expect(helpers().paidAgo(paidOn('2026-09-18'))).toEqual({ txt: 'paid 30 days ago', late: true });
  });
  it('says nothing when unpaid or there is no payment time', () => {
    expect(helpers().paidAgo({ ...paidOn('2026-10-12'), paid: false })).toBeNull();
    expect(helpers().paidAgo({ source: 'booking', paid: true, paidAt: null })).toBeNull();
  });
});

describe('timeTbc() — a dated private transfer with no pickup time', () => {
  const t = { source: 'booking', mode: 'single', stage: 'paid', date: '2026-10-25', time: null };
  it('is true for a live, dated transfer with no time', () => {
    expect(helpers().timeTbc(t)).toBe(true);
    expect(helpers().timeTbc({ ...t, date: TODAY })).toBe(true);
  });
  it('is false once the time is set, or with no date at all', () => {
    expect(helpers().timeTbc({ ...t, time: '09:00' })).toBe(false);
    expect(helpers().timeTbc({ ...t, date: null })).toBe(false);
  });
  it('is false for trips, shared seats, board vans, closed or past bookings', () => {
    expect(helpers().timeTbc({ ...t, mode: 'trip' })).toBe(false);
    expect(helpers().timeTbc({ ...t, mode: 'shared' })).toBe(false);
    expect(helpers().timeTbc({ ...t, source: 'ride_board' })).toBe(false);
    expect(helpers().timeTbc({ ...t, stage: 'cancelled' })).toBe(false);
    expect(helpers().timeTbc({ ...t, date: '2026-10-17' })).toBe(false);
  });
});

describe('ops shell: dateless cue wiring', () => {
  it('the ticket carries paidAt off the row', () => {
    expect(body).toContain('paidAt:row.paidAt||null');
  });
  it('the "paid N days ago" cue is shown only in the No date yet group', () => {
    const row = body.slice(body.indexOf('function ticketRow('), body.indexOf('function flipRows('));
    expect(row).toMatch(/dayGroup\(t\)==='No date yet'\?paidAgo\(t\):null/);
    expect(row).toContain('class="tk-paid${pa.late?\' late\':\'\'}"');
  });
  it('the when line says "time to confirm" for a transfer with no time', () => {
    const row = body.slice(body.indexOf('function ticketRow('), body.indexOf('function flipRows('));
    expect(row).toContain('${timeTbc(t)?\' · <span class="tk-tbc">time to confirm</span>\':\'\'}');
  });
});
