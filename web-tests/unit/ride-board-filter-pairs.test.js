import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');

let RB;
beforeAll(() => {
  loadTransfers();
  const src = readFileSync(path.join(ROOT, 'board.js'), 'utf8');
  // eslint-disable-next-line no-new-func
  new Function(src)();
  RB = window.RideBoard;
});

/* The two board filters were built as independent sets: every `from` ever seen in one select,
   every `to` ever seen in the other, with nothing relating them. Ella is an origin on
   Ella→Mirissa and a destination on Kandy→Ella, so it appeared in both — and "Ella to Ella"
   was selectable, returning an empty board.

   It was not just the silly case. With the live board's four origins and three destinations,
   twelve combinations were selectable and only four matched a real ride: eight dead ends.

   Deriving both option lists from the (from,to) PAIRS fixes all of it at once, and gets the
   same-place case for free — a ride list from a place to itself cannot exist, so no such pair
   is ever in the data. board.js:319 already claimed "the two selects narrow to one corridor";
   this is that, implemented. */
const PAIRS = [
  ['Colombo Airport (CMB)', 'Sigiriya / Dambulla'],
  ['Ella', 'Mirissa'],
  ['Galle', 'Mirissa'],
  ['Kandy', 'Ella'],
];

describe('RideBoard.filterOptions(pairs, filter)', () => {
  it('is exposed as a pure helper', () => {
    expect(typeof RB.filterOptions).toBe('function');
  });

  it('offers every origin and destination when nothing is filtered', () => {
    const o = RB.filterOptions(PAIRS, { from: 'all', to: 'all' });
    expect(o.from).toEqual(['Colombo Airport (CMB)', 'Ella', 'Galle', 'Kandy']);
    expect(o.to).toEqual(['Ella', 'Mirissa', 'Sigiriya / Dambulla']);
  });

  it('narrows destinations to those actually reachable from the chosen origin', () => {
    expect(RB.filterOptions(PAIRS, { from: 'Ella', to: 'all' }).to).toEqual(['Mirissa']);
    expect(RB.filterOptions(PAIRS, { from: 'Kandy', to: 'all' }).to).toEqual(['Ella']);
  });

  it('narrows origins to those that actually reach the chosen destination', () => {
    expect(RB.filterOptions(PAIRS, { from: 'all', to: 'Mirissa' }).from).toEqual(['Ella', 'Galle']);
  });

  // The bug that started this, stated as an invariant rather than a special case.
  it('never offers a place as its own destination', () => {
    const places = ['Colombo Airport (CMB)', 'Ella', 'Galle', 'Kandy', 'Mirissa', 'Sigiriya / Dambulla'];
    places.forEach((p) => {
      expect(RB.filterOptions(PAIRS, { from: p, to: 'all' }).to).not.toContain(p);
      expect(RB.filterOptions(PAIRS, { from: 'all', to: p }).from).not.toContain(p);
    });
  });

  // Every combination the UI can now produce must correspond to a real ride — that is the
  // whole point. Eight of twelve used to be dead ends.
  it('cannot produce a combination that matches no ride', () => {
    const real = new Set(PAIRS.map((p) => p.join('|')));
    const all = RB.filterOptions(PAIRS, { from: 'all', to: 'all' });
    all.from.forEach((f) => {
      RB.filterOptions(PAIRS, { from: f, to: 'all' }).to.forEach((t) => {
        expect(real.has(f + '|' + t), `${f} -> ${t} is offered but matches no ride`).toBe(true);
      });
    });
  });

  // An active filter that currently matches nothing must still render, or the select goes
  // blank next to a Clear button and the traveller cannot see what is filtering their board.
  it('keeps an active value that matches nothing, so the select is never blank', () => {
    const o = RB.filterOptions(PAIRS, { from: 'Nuwara Eliya', to: 'all' });
    expect(o.from).toContain('Nuwara Eliya');
  });

  it('survives an empty board without throwing', () => {
    const o = RB.filterOptions([], { from: 'all', to: 'all' });
    expect(o.from).toEqual([]);
    expect(o.to).toEqual([]);
  });
});
