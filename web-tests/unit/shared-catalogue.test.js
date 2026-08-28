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

// The nine directed legs we sell. from, to, seat (USD), departure time.
//
// Narrowed to the five marketed products on 2026-08-27, from the owner's operating table
// and the WordPress sales export: every product whose `trip_code` starts `single_stop_`
// and has taken a booking. Two changes came out of that reconciliation —
//   * Ella -> Mirissa/Weligama/Ahangama ($24) was a real product with sales that the
//     catalogue could not sell at all: `ella-south` had a corridor but no legs.
//   * Mirissa/Weligama -> Colombo city was sellable here but has no product page and has
//     never taken a booking. The van's marketed product ends at the airport.
const CATALOGUE = [
  ['cmb-airport', 'sigiriya', 27.49, '07:00'],
  ['negombo', 'sigiriya', 27.49, '07:30'],
  ['sigiriya', 'kandy', 19.99, '11:30'],
  ['ella', 'yala', 22.99, '09:00'],
  ['ella', 'weligama', 24, '09:00'],
  ['ella', 'ahangama', 24, '09:00'],
  ['mirissa', 'cmb-airport', 29.99, '14:45'],
  ['weligama', 'cmb-airport', 29.99, '15:00'],
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

  // Sellable here for a while, but no product page has ever carried it and it has never
  // taken a booking — the van's marketed product ends at the airport. Dropped 2026-08-27.
  it('does not sell the south-coast van to Colombo city', () => {
    expect(T.sharedOption('mirissa', 'colombo')).toBeNull();
    // The van runs Ella -> the south coast, but Mirissa is not an offer on it
    // (owner, 2026-08-27) — Weligama and Ahangama are.
    expect(T.sharedOption('ella', 'mirissa')).toBeNull();
    expect(T.sharedOption('weligama', 'colombo')).toBeNull();
  });

  // The reverse regression: a product with real sales that the catalogue could not sell,
  // because `ella-south` had a corridor and a $24 seat but no directed legs on it.
  it('sells the Ella south-coast run to the drop-offs we offer', () => {
    for (const to of ['weligama', 'ahangama']) {
      const opt = T.sharedOption('ella', to);
      expect(opt, `ella -> ${to} must be offered`).toBeTruthy();
      expect(opt.seat, `ella -> ${to} price`).toBe(24);
      expect(opt.times, `ella -> ${to} departure`).toContain('09:00');
    }
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

// One marketed product boards in several places: the Negombo→Sigiriya van leaves CMB at
// 7:00 and Negombo at 7:30. Showing only the searched leg's time hid the other pickup, so
// a traveller flying in could not tell the same van collects them at arrivals.
describe('pickup sequence', () => {
  it('lists every boarding point on the run, in departure order', () => {
    const p = T.sharedOption('negombo', 'sigiriya').pickups;
    expect(p.map(x => `${x.time} ${x.point}`)).toEqual([
      '07:00 CMB Airport',
      '07:30 Zen Cafe, Negombo',
    ]);
  });

  it('gives the same sequence whichever stop was searched', () => {
    expect(T.sharedOption('cmb-airport', 'sigiriya').pickups)
      .toEqual(T.sharedOption('negombo', 'sigiriya').pickups);
  });

  it('groups by destination, not just product id', () => {
    // ella-south-coast sells three destinations off ONE boarding in Ella, so a leg must not
    // inherit its siblings' stops — each shows Ella alone, not Ella three times.
    for (const to of ['weligama', 'ahangama']) {
      const p = T.sharedOption('ella', to).pickups;
      expect(p.map(x => x.place), `ella -> ${to}`).toEqual(['Ella']);
    }
    // And the airport run still boards twice: Mirissa 14:45, then Weligama 15:00.
    expect(T.sharedOption('mirissa', 'cmb-airport').pickups.map(x => x.place))
      .toEqual(['Mirissa', 'Weligama']);
  });

  it('leaves a single-boarding leg with one stop', () => {
    const p = T.sharedOption('sigiriya', 'kandy').pickups;
    expect(p).toHaveLength(1);
    expect(p[0].point).toBe('Barista Cafe, Sigiriya');
  });

  it('always contains the leg the traveller searched', () => {
    for (const [from, to] of CATALOGUE) {
      const s = T.sharedOption(from, to);
      expect(s.pickups.some(x => x.time === s.times[0]), `${from} -> ${to}`).toBe(true);
    }
  });
});

// The board's create form quoted the corridor's flat seat while POST /board persisted a
// distance-derived price, so the number in the modal could differ from the list created.
// boardSeatPrice mirrors the server rule exactly.
describe('boardSeatPrice mirrors POST /board', () => {
  // seatPriceForDistance, reimplemented from api/src/quote/seatPrice.ts in CENTS.
  const PER_KM_CENTS_VAN = 54.05, FLOOR_CENTS_VAN = 4999, SEATS = 3, ROUND = 50;
  const serverSeat = (km) =>
    (Math.round(Math.max(Math.round(km * PER_KM_CENTS_VAN), FLOOR_CENTS_VAN) / SEATS / ROUND) * ROUND) / 100;

  it('takes the catalogue price on a leg we sell', () => {
    expect(T.boardSeatPrice('negombo', 'sigiriya')).toBe(27.49);
    expect(T.boardSeatPrice('sigiriya', 'kandy')).toBe(19.99);
  });

  it('takes the distance price everywhere else, matching the server to the cent', () => {
    const pairs = [
      ['kandy', 'ella'], ['weligama', 'mirissa'], ['cmb-airport', 'kandy'],
      ['galle', 'bentota'], ['yala', 'galle'], ['sigiriya', 'negombo'],
    ];
    for (const [a, b] of pairs) {
      expect(T.boardSeatPrice(a, b), `${a} -> ${b}`).toBe(serverSeat(T.roadKm(a, b)));
    }
  });

  // The dollar PER_KM (0.5405) times 100 is not always the cent rate (54.05); crossing a
  // 50c boundary that way is a silent 50c disagreement with the server.
  it('agrees with the server across every baked distance', () => {
    for (const a of Object.keys(T.byId)) {
      for (const b of Object.keys(T.byId)) {
        if (a === b || T.sharedOption(a, b)) continue;
        const km = T.roadKm(a, b);
        if (!km) continue;
        expect(T.boardSeatPrice(a, b), `${a} -> ${b} @ ${km}km`).toBe(serverSeat(km));
      }
    }
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
