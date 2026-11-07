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
  legsHtmlFor = new Function('esc', 'fmtDate', 'TODAY', `${liftFn('legsHtmlFor')}; return legsHtmlFor;`)(esc, fmtDate, TODAY);
});

const trip = (input: Record<string, unknown>): Detail => ({ booking: { mode: 'trip', input } });
const rows = (html: string) => [...html.matchAll(/<div class="leg[^"]*">([\s\S]*?)<\/div>/g)].map((m) => m[1].replace(/<[^>]+>/g, ''));

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

// Owner 2026-11-05 (spec 2026-11-06-ops-multistop-next-leg-design.md §3): on a trip under way, the
// legs that have run are struck out and the next one is tagged, so ops sees where the customer is.
describe('drawer legs — progress through the trip', () => {
  const classes = (html: string) => [...html.matchAll(/<div class="(leg(?: [^"]*)?)">/g)].map((m) => m[1]);

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

  it('ships the styles those states need', () => {
    expect(body).toMatch(/\.legs \.leg-done[^{]*\{[^}]*line-through/);
    expect(body).toMatch(/\.legs \.leg-next[^{]*::after\{[^}]*content:"Next"/);
  });
});
