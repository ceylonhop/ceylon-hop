import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// Scheduled departures on the ride board (spec 2026-09-22-ride-board-scheduled-rows): the
// Wed/Sat taxis we run sit in the same day groups as the lists travellers start, drawn as
// their own kind of row. Everything here is pure; "today" is always an argument.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'shared-day.js'), 'utf8'))();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'board.js'), 'utf8'))();
  RB = window.RideBoard;
});

// Dates are built from a fixed Tuesday far enough ahead that no literal here can rot into the
// past; the helpers never read the clock, so nothing depends on when the suite runs.
const TUE = '2099-08-11'; // a Tuesday
const weekday = (iso) => new Date(iso + 'T00:00:00Z').getUTCDay();
const ALL = { from: 'all', to: 'all' };

describe('scheduledVans — one entry per van we run, read from the catalogue', () => {
  it('finds every van, each with its boarding stops in departure order', () => {
    const vans = RB.scheduledVans();
    expect(vans.length).toBeGreaterThan(0);
    const north = vans.find((v) => v.to === 'Sigiriya / Dambulla');
    expect(north.legs.map((l) => [l.place, l.time])).toEqual([
      ['Colombo Airport (CMB)', '07:00'],
      ['Negombo', '07:30'],
    ]);
    expect(north.legs[1].point).toBe('Zen Cafe, Negombo');
  });
  it('lists a van once, not once per stop it picks up at', () => {
    const vans = RB.scheduledVans();
    const keys = vans.map((v) => v.legs[0].place + '→' + v.to);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe('scheduledRows — the departures inside the window, on the days they run', () => {
  it('only Wed and Sat, after today, up to and including the last day of the window', () => {
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: TUE, days: 14, filter: ALL });
    const dates = [...new Set(rows.map((r) => r.date))];
    expect(dates).toEqual(['2099-08-12', '2099-08-15', '2099-08-19', '2099-08-22']);
    dates.forEach((d) => expect([3, 6]).toContain(weekday(d)));
  });
  it('never offers today: a seat on a van that leaves today is not an offer', () => {
    const wed = '2099-08-12';
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: wed, days: 3, filter: ALL });
    expect(rows.map((r) => r.date)).not.toContain(wed);
    expect(rows.every((r) => r.date === '2099-08-15')).toBe(true);
  });
  it('unfiltered, a van shows from its first stop', () => {
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: TUE, days: 1, filter: ALL });
    const north = rows.find((r) => r.to === 'Sigiriya / Dambulla');
    expect(north).toMatchObject({ sched: true, date: '2099-08-12', from: 'Colombo Airport (CMB)', time: '07:00',
      fromId: 'cmb-airport', toId: 'sigiriya', seat: 27.49, point: 'CMB Airport' });
  });
  it('filtered to a later stop, the row is that stop: its time and its pickup point', () => {
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: TUE, days: 1,
      filter: { from: 'Negombo', to: 'Sigiriya / Dambulla' } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ from: 'Negombo', fromId: 'negombo', time: '07:30', point: 'Zen Cafe, Negombo' });
  });
  it('a route we do not schedule gets no scheduled rows', () => {
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: TUE, days: 14, filter: { from: 'Kandy', to: 'Ella' } });
    expect(rows).toEqual([]);
  });
  it('"My rides" is about your lists — never scheduled rows', () => {
    const rows = RB.scheduledRows(RB.scheduledVans(), { todayIso: TUE, days: 14, filter: { ...ALL, mine: true } });
    expect(rows).toEqual([]);
  });
});

describe('groupByDay — scheduled departures by clock time, lists by the start of their window', () => {
  it('orders a day by when things leave', () => {
    const morning = { code: 'M', date: '2099-08-12', slot: 'morning' };
    const afternoon = { code: 'A', date: '2099-08-12', slot: 'afternoon' };
    const s0700 = { sched: true, date: '2099-08-12', time: '07:00', to: 'x' };
    const s0900 = { sched: true, date: '2099-08-12', time: '09:00', to: 'y' };
    const s1445 = { sched: true, date: '2099-08-12', time: '14:45', to: 'z' };
    const g = RB.groupByDay([morning, afternoon, s1445, s0900, s0700]);
    const order = g[0].lists.map((x) => x.code || x.time);
    // a list's morning window starts at 7:00, so it ties with the 07:00 van and keeps its place
    expect(order).toEqual(['M', '07:00', '09:00', 'A', '14:45']);
  });
});

describe('horizonAt — where "scheduled taxis keep running" goes', () => {
  const groups = (dates) => dates.map((date) => ({ date }));
  it('before the first day past the window', () => {
    expect(RB.horizonAt(groups(['2099-08-12', '2099-08-22', '2099-08-23', '2099-09-01']), '2099-08-25')).toBe(3);
  });
  it('at the end when every day is inside the window', () => {
    expect(RB.horizonAt(groups(['2099-08-12', '2099-08-15']), '2099-08-25')).toBe(2);
  });
  it('treats a dateless list as beyond the window', () => {
    expect(RB.horizonAt(groups(['2099-08-12', null]), '2099-08-25')).toBe(1);
  });
});

describe('when a traveller ride is decided', () => {
  it('a gathering row names the day its cutoff falls on, in Sri Lanka time', () => {
    // 20:00 UTC is 01:30 the next morning in Colombo
    const cutoffMs = Date.parse('2099-08-19T20:00:00Z');
    const s = RB.rowState({ minSeats: 3, capacity: 6, committed: 2, confirmed: false, cutoffMs }, false);
    expect(s.sub).toBe('needs 1 more');
    expect(s.decided).toBe(RB.fmtDate('2099-08-20'));
  });
  it('says nothing when the cutoff is unknown', () => {
    const s = RB.rowState({ minSeats: 3, capacity: 6, committed: 2, confirmed: false, cutoffMs: NaN }, false);
    expect(s.decided).toBeUndefined();
  });
  it('a locked or full row has already been decided — no date', () => {
    const cutoffMs = Date.parse('2099-08-19T20:00:00Z');
    const s = RB.rowState({ minSeats: 3, capacity: 6, committed: 4, confirmed: true, cutoffMs }, false);
    expect(s.sub).toBe('2 seats left');
    expect(s.decided).toBeUndefined();
  });
});

describe('the verbs — Book for a scheduled seat, Join for a traveller ride', () => {
  it('a gathering row says Join', () => {
    const s = RB.rowState({ minSeats: 3, capacity: 6, committed: 1, confirmed: false }, false);
    expect(s.cta).toEqual({ kind: 'view', text: 'Join' });
  });
});

describe('relativeDay — when, in the words people use', () => {
  it('today, tomorrow, this week by name, then next week', () => {
    expect(RB.relativeDay(TUE, TUE)).toBe('Today');
    expect(RB.relativeDay('2099-08-12', TUE)).toBe('Tomorrow');
    expect(RB.relativeDay('2099-08-14', TUE)).toBe('This Friday');
    expect(RB.relativeDay('2099-08-18', TUE)).toBe('Next week');
    expect(RB.relativeDay('2099-08-25', TUE)).toBe('');
  });
  it('says nothing for the past or a missing date', () => {
    expect(RB.relativeDay('2099-08-10', TUE)).toBe('');
    expect(RB.relativeDay(null, TUE)).toBe('');
  });
});

describe('colomboToday — the board runs on Sri Lanka dates', () => {
  it('rolls over at midnight in Colombo, not UTC', () => {
    expect(RB.colomboToday(Date.parse('2099-08-11T18:29:00Z'))).toBe('2099-08-11');
    expect(RB.colomboToday(Date.parse('2099-08-11T18:30:00Z'))).toBe('2099-08-12');
  });
});
