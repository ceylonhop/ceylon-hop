import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// A shared seat used to be offered wherever two places were ADJACENT on a corridor's
// `stops` array. That is not what Ceylon Hop sells: 32 of 44 trip pages advertised a
// seat, 16 of them the REVERSE of the corridor's direction (kandy-to-cmb-airport sold
// a 07:30 van that runs the other way), and only 4 were real products.
//
// Offers now come from an explicit catalogue of the directed legs we actually sell,
// sourced from the live product pages (2026-08-16). Adjacency is NOT an offer.
//
// `corridorFor()` keeps the old broad matching — the ride board pools routes we do
// not schedule, so narrowing what we advertise must not narrow what people can pool.
let T;
beforeAll(() => { T = loadTransfers(); });

// The eight directed legs we sell. from, to, seat (USD), departure time.
const CATALOGUE = [
  ['cmb-airport', 'sigiriya', 27.49, '07:00'],
  ['negombo', 'sigiriya', 27.49, '07:30'],
  ['sigiriya', 'kandy', 19.99, '11:30'],
  ['ella', 'yala', 22.99, '09:00'],
  ['mirissa', 'cmb-airport', 29.99, '14:45'],
  ['weligama', 'cmb-airport', 29.99, '15:00'],
  ['mirissa', 'colombo', 29.99, '14:45'],
  ['weligama', 'colombo', 29.99, '15:00'],
];

describe('shared catalogue — what we actually sell', () => {
  it('offers a seat on every catalogue leg, at its price and departure time', () => {
    for (const [from, to, seat, departs] of CATALOGUE) {
      const opt = T.sharedOption(from, to);
      expect(opt, `${from} -> ${to} must be offered`).toBeTruthy();
      expect(opt.seat, `${from} -> ${to} price`).toBe(seat);
      expect(opt.times, `${from} -> ${to} departure`).toContain(departs);
    }
  });

  it('offers nothing on any other pair', () => {
    const sold = new Set(CATALOGUE.map(([f, t]) => `${f}|${t}`));
    for (const a of Object.keys(T.byId)) {
      for (const b of Object.keys(T.byId)) {
        if (a === b || sold.has(`${a}|${b}`)) continue;
        expect(T.sharedOption(a, b), `${a} -> ${b} must NOT be offered`).toBeNull();
      }
    }
  });

  it('is directional — the reverse of a sold leg is not sold', () => {
    for (const [from, to] of CATALOGUE) {
      expect(T.sharedOption(to, from), `${to} -> ${from} is the reverse`).toBeNull();
    }
  });

  // The specific regressions that motivated this change.
  it('no longer sells the phantom routes', () => {
    expect(T.sharedOption('kandy', 'cmb-airport')).toBeNull();   // reverse of the 07:00 van
    expect(T.sharedOption('sigiriya', 'negombo')).toBeNull();    // reverse of a real product
    expect(T.sharedOption('weligama', 'mirissa')).toBeNull();    // 7 km, never a service
    expect(T.sharedOption('kandy', 'nuwara-eliya')).toBeNull();  // adjacency only
    expect(T.sharedOption('yala', 'mirissa')).toBeNull();        // withdrawn product
    expect(T.sharedOption('ella', 'arugam-bay')).toBeNull();     // withdrawn product
  });

  // Weligama->Mirissa sat on south-coast ($14), yala-south ($16) and ella-south ($24);
  // sharedOption() returned whichever corridor was declared first, so one 7 km hop had
  // three prices. A directed catalogue has no corridor to be ambiguous about.
  it('gives one answer per leg, not one per corridor declaration order', () => {
    for (const [from, to] of CATALOGUE) {
      const seats = new Set([T.sharedOption(from, to).seat, T.sharedOption(from, to).seat]);
      expect(seats.size).toBe(1);
    }
  });
});

// The chips, titles and FAQ on a trip page are generated from sharedOption(), so they
// narrowed automatically. The route INTROS are hand-written prose in route-content.json
// and the generator cannot police them — 12 of them still promised a shared seat on legs
// we do not sell ("a cheaper shared seat from the airport covers this run too"), which is
// the same false promise in the one place the type system could not reach.
describe('route-content prose only mentions a shared seat where we sell one', () => {
  const content = JSON.parse(
    readFileSync(path.resolve(__dirname, '../../tools/route-content.json'), 'utf8'),
  );

  it('makes no shared-seat claim on a pair we do not sell', () => {
    const offenders = [];
    for (const [key, pair] of Object.entries(content.pairs)) {
      const [a, b] = key.split('|');
      // route-content keys are undirected — a claim is fair if EITHER direction sells.
      if (T.sharedOption(a, b) || T.sharedOption(b, a)) continue;
      for (const field of ['intro', 'back']) {
        if (/shared/i.test(pair[field] || '')) offenders.push(`${key}.${field}`);
      }
    }
    expect(offenders, `prose promises a shared seat we do not sell:\n${offenders.join('\n')}`)
      .toEqual([]);
  });

  it('quotes the right departure time where it quotes one', () => {
    // Ella->Yala departs 09:00 (Barn by Starbeans). The copy said 8:00am.
    const ellaYala = content.pairs['ella|yala'];
    expect(T.sharedOption('ella', 'yala').times).toContain('09:00');
    expect(`${ellaYala.intro} ${ellaYala.back || ''}`).not.toMatch(/8[:.]00\s*am|8am/i);
  });
});

describe('corridorFor — the ride board keeps pooling everything', () => {
  it('still resolves pairs that are no longer sold as scheduled seats', () => {
    for (const [a, b] of [
      ['weligama', 'mirissa'], ['kandy', 'nuwara-eliya'], ['yala', 'mirissa'],
      ['ella', 'arugam-bay'], ['cmb-airport', 'kandy'], ['galle', 'bentota'],
    ]) {
      expect(T.corridorFor(a, b), `${a} -> ${b} must stay poolable`).toBeTruthy();
    }
  });

  it('resolves the new south-airport corridor in both directions', () => {
    expect(T.corridorFor('mirissa', 'cmb-airport')).toBeTruthy();
    expect(T.corridorFor('cmb-airport', 'weligama')).toBeTruthy();
  });

  it('still returns null for a pair no corridor carries', () => {
    expect(T.corridorFor('trincomalee', 'galle')).toBeNull();
    expect(T.corridorFor('galle', 'galle')).toBeNull();
  });
});
