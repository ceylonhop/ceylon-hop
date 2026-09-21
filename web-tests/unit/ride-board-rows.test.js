import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

// Pure helpers behind the row layout of the ride board (spec 2026-09-18-ride-board-rows).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  // eslint-disable-next-line no-new-func
  new Function(readFileSync(path.join(ROOT, 'board.js'), 'utf8'))();
  RB = window.RideBoard;
});

const L = (o) => ({ minSeats: 4, capacity: 6, committed: 1, confirmed: false, slot: 'morning', ...o });

describe('windowLabel — departures are 2-hour windows, never a clock time', () => {
  it('names each slot by its window', () => {
    expect(RB.windowLabel('morning')).toBe('7–9 am');
    expect(RB.windowLabel('afternoon')).toBe('1–3 pm');
  });
  it('falls back to the morning window like slotWindow does', () => {
    expect(RB.windowLabel('nonsense')).toBe('7–9 am');
  });
});

describe('durationOf — the only fact under a route', () => {
  it('trims the corridor time to the duration', () => {
    expect(RB.durationOf({ corridorId: 'airport-cultural' })).toBe('~4h');
    expect(RB.durationOf({ corridorId: 'south-coast' })).toBe('~1.5h');
  });
  it('says nothing for an unknown corridor rather than guessing', () => {
    expect(RB.durationOf({ corridorId: 'nowhere' })).toBe('');
    expect(RB.durationOf({})).toBe('');
  });
});

describe('groupByDay — day headings in date order, morning before afternoon', () => {
  it('groups, sorts days and sorts slots within a day', () => {
    const a = L({ code: 'A', date: '2099-08-16', slot: 'morning' });
    const b = L({ code: 'B', date: '2099-08-15', slot: 'afternoon' });
    const c = L({ code: 'C', date: '2099-08-15', slot: 'morning' });
    const g = RB.groupByDay([a, b, c]);
    expect(g.map((d) => d.date)).toEqual(['2099-08-15', '2099-08-16']);
    expect(g[0].lists.map((x) => x.code)).toEqual(['C', 'B']);
    expect(g[0].label).toBe('Sat 15 Aug');
  });
  it('puts a list with no date last instead of dropping it', () => {
    const g = RB.groupByDay([L({ code: 'N', date: null }), L({ code: 'D', date: '2099-08-15' })]);
    expect(g.map((d) => d.lists[0].code)).toEqual(['D', 'N']);
    expect(g[1].label).toBe('Date to be set');
  });
  it('handles an empty board', () => {
    expect(RB.groupByDay([])).toEqual([]);
  });
});

describe('rowState — one coloured state and one action per row', () => {
  it('gathering: amber count, how many more, Hop on', () => {
    const s = RB.rowState(L({ committed: 3 }), false);
    expect(s).toEqual({ cls: 'g', label: '3 of 4 in', sub: 'needs 1 more', cta: { kind: 'view', text: 'Hop on' } });
  });
  it('minimum reached but still gathering: green, seats left, still Hop on (#599)', () => {
    const s = RB.rowState(L({ committed: 4 }), false);
    expect(s.cls).toBe('l');
    expect(s.label).toBe('Locked in');
    expect(s.sub).toBe('2 seats left');
    expect(s.cta).toEqual({ kind: 'view', text: 'Hop on' });
  });
  it("confirmed (cutoff passed): no join invitation — See who's going (#597)", () => {
    const s = RB.rowState(L({ committed: 5, confirmed: true }), false);
    expect(s.sub).toBe('1 seat left');
    expect(s.cta).toEqual({ kind: 'view', text: "See who's going" });
  });
  it('full and not yours: grey, Start another taxi', () => {
    const s = RB.rowState(L({ committed: 6, confirmed: true }), false);
    expect(s).toEqual({ cls: 'f', label: 'Full', sub: '6 of 6', cta: { kind: 'again', text: 'Start another taxi' } });
  });
  it("yours: View your ride, and the state says you're on it", () => {
    expect(RB.rowState(L({ committed: 2 }), true)).toMatchObject({
      sub: "needs 2 more · you're on it", cta: { kind: 'view', text: 'View your ride' },
    });
    expect(RB.rowState(L({ committed: 6, confirmed: true }), true).cta).toEqual({ kind: 'view', text: 'View your ride' });
  });
});

describe('splitPlace — the city reads first, the qualifier is small', () => {
  it('splits a bracketed code off the name', () => {
    expect(RB.splitPlace('Colombo Airport (CMB)')).toEqual({ main: 'Colombo Airport', qual: '(CMB)' });
  });
  it('splits a slashed alias off the name', () => {
    expect(RB.splitPlace('Sigiriya / Dambulla')).toEqual({ main: 'Sigiriya', qual: '/ Dambulla' });
  });
  it('leaves a plain name whole', () => {
    expect(RB.splitPlace('Ella')).toEqual({ main: 'Ella', qual: '' });
    expect(RB.splitPlace('')).toEqual({ main: '', qual: '' });
  });
});

// Spec 2026-09-19-shared-ride-by-day: the board must not start a second van on a day the
// scheduled one already runs. The API enforces it (409 scheduled_day); this is the same rule in
// the browser, so the start form can say so BEFORE sending the traveller through sign-in.
describe('scheduledClash — does this route and date belong to the scheduled van?', () => {
  it('names the clash on a service day, with what the guaranteed seat offers', () => {
    expect(RB.scheduledClash('negombo', 'sigiriya', '2099-08-15')).toEqual({ weekday: 'Saturdays', time: '07:30', seat: 27.49 });
    expect(RB.scheduledClash('negombo', 'sigiriya', '2099-08-12').weekday).toBe('Wednesdays');
  });
  it('is clear on a day the van does not run', () => {
    expect(RB.scheduledClash('negombo', 'sigiriya', '2099-08-13')).toBeNull();
  });
  it('never claims a leg we do not sell as a scheduled seat', () => {
    expect(RB.scheduledClash('cmb-airport', 'kandy', '2099-08-15')).toBeNull();
  });
  it('says nothing until route and date are all chosen', () => {
    expect(RB.scheduledClash('', 'sigiriya', '2099-08-15')).toBeNull();
    expect(RB.scheduledClash('negombo', 'sigiriya', '')).toBeNull();
    expect(RB.scheduledClash('negombo', 'sigiriya', 'not-a-date')).toBeNull();
  });
});
