import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { futureIsoDate } from '../dates.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// The booking pane's job helpers live between two markers in ops-ui.html (house extraction
// pattern: see ops-booking-addons.test.js). They are pure, so they load with no page globals.
function load() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/\/\* @sheet-job:start[\s\S]*?\/\* @sheet-job:end \*\//);
  if (!m) throw new Error('@sheet-job block not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function(m[0] + '\nreturn { shortPlace, roadOf, legRows, jobFacts };')();
}
const { shortPlace, roadOf, legRows, jobFacts } = load();

// Dates are anchored to now (web-tests/dates.js); `on(n)` is n days from today, so `on(-3)` is
// a past date and `on(2)` a future one. The ordering between the dates is what each test checks.
const TODAY = futureIsoDate(0);
const on = (n) => futureIsoDate(n);
const trip = (input) => ({ mode: 'trip', input: { pax: 2, vehicleType: 'car', serviceType: 'private', ...input } });

describe('shortPlace', () => {
  it('keeps the text before the first comma', () => {
    expect(shortPlace('Grand Royal villa Negombo, Saint Joseph Mawatha, Negombo')).toBe('Grand Royal villa Negombo');
  });
  it('keeps a comma-less name whole, and copes with nothing', () => {
    expect(shortPlace('Ella')).toBe('Ella');
    expect(shortPlace('  Kandy  ')).toBe('Kandy');
    expect(shortPlace(undefined)).toBe('');
  });
});

describe('roadOf', () => {
  it('names the toll-free road in ops’ words', () => {
    expect(roadOf('no_tolls')).toEqual({ text: 'No expressway', cls: 'road-local' });
  });
  it('treats every other road as the usual route', () => {
    expect(roadOf('fastest')).toEqual({ text: 'Expressway OK', cls: 'road' });
    expect(roadOf(undefined)).toEqual({ text: 'Expressway OK', cls: 'road' });
  });
});

describe('legRows: trips', () => {
  const b = trip({
    stops: ['Negombo, A', 'Ella, B', 'Panama, C', 'Udawalawe, D'],
    dates: [on(-3), on(-1), on(2)],
    routeVariants: ['fastest', 'no_tolls', 'fastest'],
  });

  it('marks legs before today done and the first one on or after today next', () => {
    const rows = legRows(b, TODAY);
    expect(rows.map((r) => [r.n, r.done, r.next])).toEqual([[1, true, false], [2, true, false], [3, false, true]]);
  });

  it('carries the road each leg was priced on', () => {
    expect(legRows(b, TODAY).map((r) => r.variant)).toEqual(['fastest', 'no_tolls', 'fastest']);
  });

  it('keeps full stop strings for the addresses', () => {
    expect(legRows(b, TODAY)[2]).toMatchObject({ from: 'Panama, C', to: 'Udawalawe, D', date: on(2), time: null });
  });

  it('turns a gap into a self-arranged row and never drives it', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C'], dates: [on(4), on(5)], gaps: [0] }), TODAY);
    expect(rows[0]).toEqual({ kind: 'gap', n: 1, from: 'A', to: 'B' });
    expect(rows[1]).toMatchObject({ kind: 'leg', n: 2, next: true });
  });

  it('folds stops on the way into one leg, and flags it toll-free if any part is', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C', 'D'], dates: [on(4), null, on(6)], through: [0], routeVariants: ['fastest', 'no_tolls', 'fastest'] }), TODAY);
    expect(rows[0]).toMatchObject({ kind: 'leg', n: 1, from: 'A', to: 'C', via: ['B'], variant: 'no_tolls' });
    expect(rows[1]).toMatchObject({ kind: 'leg', n: 2, from: 'C', to: 'D' });
  });

  it('never marks an undated leg done or next', () => {
    const rows = legRows(trip({ stops: ['A', 'B', 'C'] }), TODAY);
    expect(rows.every((r) => !r.done && !r.next)).toBe(true);
  });
});

describe('legRows: single and shared', () => {
  it('gives a single transfer one row with its time and road', () => {
    const b = { mode: 'single', input: { from: 'CMB Airport, Katunayake', to: 'Kandy, Earl’s', date: on(4), time: '06:30', routeVariant: 'no_tolls' } };
    expect(legRows(b, TODAY)).toEqual([{ kind: 'leg', n: 1, date: on(4), time: '06:30', from: 'CMB Airport, Katunayake', to: 'Kandy, Earl’s', via: [], variant: 'no_tolls', done: false, next: true }]);
  });

  it('treats a single transfer dated exactly today as next, not done', () => {
    const b = { mode: 'single', input: { from: 'A, x', to: 'B, y', date: TODAY } };
    const [r] = legRows(b, TODAY);
    expect(r.next).toBe(true);
    expect(r.done).toBe(false);
  });

  it('gives a shared seat its catalogue leg and no road', () => {
    const b = { mode: 'shared', input: { corridorId: 'c1', fromPlace: 'Ella', toPlace: 'Mirissa', date: on(8), time: '07:30', seats: 2 } };
    expect(legRows(b, TODAY)[0]).toMatchObject({ from: 'Ella', to: 'Mirissa', time: '07:30', variant: null });
  });

  it('returns nothing for a shared row that never recorded its leg', () => {
    expect(legRows({ mode: 'shared', input: { corridorId: 'c1', date: on(8), time: '07:30', seats: 1 } }, TODAY)).toEqual([]);
  });
});

describe('jobFacts', () => {
  it('reads a single transfer’s vehicle, adults/children and bags', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 2, children: 1, bags: 4 } };
    const f = jobFacts(b, 'van', null, legRows(b, TODAY));
    expect(f.vehicle).toEqual({ kind: 'vehicle', code: 'van', chauffeurDays: null });
    expect(f.guests).toEqual({ total: 3, adults: 2, children: 1 });
    expect(f.bags).toEqual({ asked: true, count: 4 });
    expect(f.when.label).toBe('When');
  });

  it('says a trip never asked for bags', () => {
    const b = trip({ stops: ['A', 'B'], pax: 3 });
    const f = jobFacts(b, 'car', 'private', legRows(b, TODAY));
    expect(f.bags).toEqual({ asked: false, count: null });
    expect(f.guests).toEqual({ total: 3, adults: null, children: null });
  });

  it('adds the days to a chauffeur guide’s vehicle', () => {
    const b = trip({ stops: ['A', 'B'], serviceType: 'chauffeur', days: 6, driverNights: 5 });
    expect(jobFacts(b, 'car', 'chauffeur', legRows(b, TODAY)).vehicle).toEqual({ kind: 'vehicle', code: 'car', chauffeurDays: 6 });
  });

  it('shows seats, not a vehicle, for a shared booking', () => {
    const b = { mode: 'shared', input: { corridorId: 'c1', date: on(8), time: '07:30', seats: 2, bags: 2 } };
    const f = jobFacts(b, null, null, legRows(b, TODAY));
    expect(f.vehicle).toEqual({ kind: 'shared', seats: 2 });
    expect(f.when.label).toBe('Departs');
    expect(f.bags).toEqual({ asked: true, count: 2 });
  });

  it('flags a missing vehicle instead of leaving it blank', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 1, children: 0 } };
    expect(jobFacts(b, null, null, legRows(b, TODAY)).vehicle).toEqual({ kind: 'missing' });
  });

  it('reports bags as not recorded on an older row that has no bags field', () => {
    const b = { mode: 'single', input: { from: 'A', to: 'B', adults: 1, children: 0 } };
    expect(jobFacts(b, 'car', null, legRows(b, TODAY)).bags).toEqual({ asked: true, count: null });
  });

  it('switches When to the next leg once a trip is under way', () => {
    const b = trip({ stops: ['A', 'B', 'C', 'D'], dates: [on(-3), on(-1), on(2)] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when).toEqual({ label: 'Next leg', date: on(2), k: 3, m: 3, start: on(-3) });
  });

  it('says Flexible for the next leg when the rest of a started trip has no date', () => {
    const b = trip({ stops: ['A', 'B', 'C', 'D'], dates: [on(-3), on(-1), ''] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when).toEqual({ label: 'Next leg', date: null, k: 3, m: 3, start: on(-3) });
  });

  it('points at the first undated leg that has not run, not a done one', () => {
    const b = trip({ stops: ['A', 'B', 'C', 'D'], dates: [on(-3), '', ''] });
    const w = jobFacts(b, 'car', 'private', legRows(b, TODAY)).when;
    expect(w).toEqual({ label: 'Next leg', date: null, k: 2, m: 3, start: on(-3) });
  });

  it('keeps When and the start date on a trip whose legs have all run', () => {
    const b = trip({ stops: ['A', 'B', 'C'], dates: [on(-3), on(-1)] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when.label).toBe('When');
  });

  it('keeps When on a trip that has not started', () => {
    const b = trip({ stops: ['A', 'B', 'C'], dates: [on(4), on(6)] });
    expect(jobFacts(b, 'car', 'private', legRows(b, TODAY)).when.label).toBe('When');
  });
});
