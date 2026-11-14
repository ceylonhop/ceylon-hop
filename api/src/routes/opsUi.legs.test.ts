import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// The drawer's leg list (legsHtmlFor). known-bugs 2026-07-30 / 2026-08-04: a trip's self-arranged
// stretch (the customer's own Ella → Galle train, or the leg a partial pay link left out) rendered
// as a leg we drive, so a driver briefing could send a car for it.

let body = '';
// Anchored to the real clock, so the leg states never time-bomb (web-tests' no-date-bombs rule).
const iso = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000).toISOString().slice(0, 10);
const TODAY = iso(0);

/** Lift `function NAME(…){…}` out of the ops shell by brace matching. */
function liftFn(name: string): string {
  const start = body.indexOf(`function ${name}(`);
  expect(start, `${name} not found in the ops shell`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = body.indexOf('{', start); i < body.length; i++) {
    if (body[i] === '{') depth++;
    else if (body[i] === '}' && --depth === 0) return body.slice(start, i + 1);
  }
  throw new Error(`${name} never terminated`);
}

type Detail = { booking: { mode: string; input: Record<string, unknown> }; coverage?: unknown };
let legsHtmlFor: (d: Detail) => string;

beforeAll(async () => {
  body = await (await createApp().request('/ops')).text();
  const esc = (s: string) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const fmtDate = (s: string) => `D(${s})`;
  // legsHtmlFor is built on the pure helper block (shortPlace / roadOf / legRows), so lift that too.
  const helpers = body.slice(body.indexOf('/* @sheet-job:start'), body.indexOf('/* @sheet-job:end'));
  expect(helpers, 'sheet-job helper block not found in the ops shell').not.toBe('');
  legsHtmlFor = new Function('esc', 'fmtDate', 'TODAY', `${helpers}\n${liftFn('legsHtmlFor')}; return legsHtmlFor;`)(esc, fmtDate, TODAY);
});

const trip = (input: Record<string, unknown>): Detail => ({ booking: { mode: 'trip', input } });
// One entry per leg line: the text of its `.r` (date · places · via), without the road label or addresses.
const rows = (html: string) => [...html.matchAll(/<div class="lt"><span class="r">([\s\S]*?)<\/span>(?:<span class="road|<\/div>)/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

describe('drawer legs', () => {
  it("shows a gap as the customer's own travel, not a leg we drive", () => {
    const html = legsHtmlFor(trip({
      stops: ['Colombo', 'Ella', 'Galle', 'Colombo'],
      dates: ['2026-11-02', '', '2026-11-05'],
      gaps: [1],
    }));
    const r = rows(html);
    expect(r).toHaveLength(3);
    expect(r[0]).toBe('D(2026-11-02) · Colombo → Ella');
    expect(r[1]).toBe('Ella → Galle · customer’s own travel, not driven by us');
    expect(r[2]).toBe('D(2026-11-05) · Galle → Colombo');
    expect(html).toContain('class="leg leg-gap"');
  });

  it('leaves a trip without gaps exactly as before', () => {
    const r = rows(legsHtmlFor(trip({ stops: ['A', 'B', 'C'], dates: ['2026-11-02'] })));
    expect(r).toEqual(['D(2026-11-02) · A → B', 'Leg 2 · B → C']);
  });
});

// Stops on the way (trip_request.through, 0078): wire i continues the same ride onto wire i+1, so
// stops[i+1] is a place the car passes through, not the end of a transfer. Drawn one row per hop it
// read as two same-day transfers — a driver briefing could book two pickups for one ride.
describe('drawer legs — stops on the way', () => {
  it('draws a ride with a stop on the way as ONE leg, naming the stop', () => {
    const r = rows(legsHtmlFor(trip({
      stops: ['Negombo', 'Colombo city', 'Anuradhapura'],
      dates: ['2026-11-12', '2026-11-12'],
      through: [0],
    })));
    expect(r).toEqual(['D(2026-11-12) · Negombo → Anuradhapura via Colombo city']);
  });

  it('names several stops on the way in order, and keeps the overnight legs around them', () => {
    const r = rows(legsHtmlFor(trip({
      stops: ['Colombo', 'Kandy', 'Dambulla', 'Sigiriya', 'Ella'],
      dates: ['2026-11-12', '2026-11-12', '2026-11-12', '2026-11-15'],
      through: [0, 1],
    })));
    expect(r).toEqual([
      'D(2026-11-12) · Colombo → Sigiriya via Kandy, Dambulla',
      'D(2026-11-15) · Sigiriya → Ella',
    ]);
  });

  it('keeps the customer’s own travel apart from a ride with stops', () => {
    const r = rows(legsHtmlFor(trip({
      stops: ['A', 'B', 'C', 'D'],
      dates: ['2026-11-12', '2026-11-12', ''],
      through: [0],
      gaps: [2],
    })));
    expect(r).toEqual(['D(2026-11-12) · A → C via B', 'C → D · customer’s own travel, not driven by us']);
  });

  it('numbers undated legs by row, and flags a local road on any hop of the ride', () => {
    const r = rows(legsHtmlFor(trip({
      stops: ['A', 'B', 'C', 'D'],
      through: [1],
      routeVariants: ['fastest', 'no_tolls', 'fastest'],
    })));
    expect(r).toEqual(['Leg 1 · A → B', 'Leg 2 · B → D via C']);
    // The road is its own label, per leg: the ride with a toll-free hop says so, the other does not.
    expect([...legsHtmlFor(trip({ stops: ['A', 'B', 'C', 'D'], through: [1], routeVariants: ['fastest', 'no_tolls', 'fastest'] })).matchAll(/data-testid="leg-road">([^<]*)</g)].map((m) => m[1])).toEqual(['Expressway OK', 'No expressway']);
  });

  it('strikes out or tags the whole ride, never its stop on the way', () => {
    const classes = (html: string) => [...html.matchAll(/<div class="(leg(?: [^"]*)?)" data-leg="\d+">/g)].map((m) => m[1]);
    const html = legsHtmlFor(trip({ stops: ['A', 'B', 'C', 'D'], dates: [iso(-1), iso(2), iso(2)], through: [1] }));
    expect(classes(html)).toEqual(['leg leg-done', 'leg leg-next']);
  });
});

// Owner 2026-11-05 (spec 2026-11-06-ops-multistop-next-leg-design.md §3): on a trip under way, the
// legs that have run are struck out and the next one is tagged, so ops sees where the customer is.
describe('drawer legs — progress through the trip', () => {
  const classes = (html: string) => [...html.matchAll(/<div class="(leg(?: [^"]*)?)" data-leg="\d+">/g)].map((m) => m[1]);

  it('strikes out the legs before today and tags the next one; later and undated legs stay plain', () => {
    const html = legsHtmlFor(trip({
      stops: ['Colombo', 'Kandy', 'Ella', 'Yala', 'Galle', 'Colombo'],
      dates: [iso(-3), iso(-1), iso(0), iso(2), ''],
    }));
    expect(classes(html)).toEqual(['leg leg-done', 'leg leg-done', 'leg leg-next', 'leg', 'leg']);
  });

  it('keeps the wording of every leg as it was — the state is styling, not text', () => {
    const r = rows(legsHtmlFor(trip({ stops: ['A', 'B', 'C'], dates: [iso(-1), iso(1)] })));
    expect(r).toEqual([`D(${iso(-1)}) · A → B`, `D(${iso(1)}) · B → C`]);
  });

  it('never tags a self-arranged stretch as next', () => {
    const html = legsHtmlFor(trip({ stops: ['A', 'B', 'C', 'D'], dates: [iso(-1), iso(1), iso(2)], gaps: [1] }));
    expect(classes(html)).toEqual(['leg leg-done', 'leg leg-gap', 'leg leg-next']);
  });

  it('marks a whole finished trip done, with nothing next', () => {
    const html = legsHtmlFor(trip({ stops: ['A', 'B', 'C'], dates: [iso(-3), iso(-1)] }));
    expect(classes(html)).toEqual(['leg leg-done', 'leg leg-done']);
  });

  it('says so when a shared booking recorded no leg', () => {
    expect(legsHtmlFor({ booking: { mode: 'shared', input: {} } })).toContain('No leg breakdown on record for this booking.');
  });

  it('ships the styles those states need', () => {
    expect(body).toMatch(/\.legs \.leg-done[^{]*\{[^}]*line-through/);
    expect(body).toMatch(/\.legs \.leg-next[^{]*::after\{[^}]*content:"Next"/);
  });
});
