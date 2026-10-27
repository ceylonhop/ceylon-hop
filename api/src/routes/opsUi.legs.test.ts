import { describe, it, expect, beforeAll } from 'vitest';
import { createApp } from '../app';

// The drawer's leg list (legsHtmlFor). known-bugs 2026-07-30 / 2026-08-04: a trip's self-arranged
// stretch (the customer's own Ella → Galle train, or the leg a partial pay link left out) rendered
// as a leg we drive, so a driver briefing could send a car for it.

let body = '';

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
  legsHtmlFor = new Function('esc', 'fmtDate', `${liftFn('legsHtmlFor')}; return legsHtmlFor;`)(esc, fmtDate);
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
