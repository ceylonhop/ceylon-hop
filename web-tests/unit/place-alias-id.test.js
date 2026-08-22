import { describe, it, expect } from 'vitest';
import { loadTransfers } from './_load.js';

// ────────────────────────────────────────────────────────────────────────────
//  `placeAliasId` — "is this free-text label one of OUR catalogue places?"
//
//  Google suggestions arrive as a full prediction string ("Sigiriya, Sri Lanka")
//  while the catalogue calls the same place "Sigiriya / Dambulla". Nothing on the
//  name path could see through that, so the picker offered BOTH rows and picking
//  the Google one dropped the catalogue id — which is what decides baked pricing
//  and whether `sharedOption` is ever consulted (search.js:155).
//
//  The matcher is EXACT after stripping the country suffix, never a substring
//  test. ch-shortplace.js:21 records why: "Umbrella Cafe" contains "ella", and a
//  substring rule would swallow the town of Ella. The failure direction is
//  deliberate — a miss leaves today's behaviour (engine price, no shared card),
//  while a false hit would swap a named pickup for an area centroid.
//
//  Aliases are the place's own vocabulary only: its name, that name without the
//  parenthetical, and its id. Notably NOT the halves of a slash-joined name —
//  "Dambulla" is ~17km from Sigiriya and folding it in is the owner's call, not
//  a freebie (deferred 2026-08-22).
// ────────────────────────────────────────────────────────────────────────────

const T = loadTransfers();

describe('placeAliasId — accepts a place stated in its own vocabulary', () => {
  it.each([
    ['Sigiriya, Sri Lanka', 'sigiriya'],          // the Google row from the reported bug
    ['Sigiriya', 'sigiriya'],
    ['Sigiriya / Dambulla', 'sigiriya'],          // the catalogue's own label
    ['Colombo Airport (CMB)', 'cmb-airport'],
    ['Colombo Airport, Sri Lanka', 'cmb-airport'], // parenthetical dropped
    ['CMB Airport', 'cmb-airport'],                // the id, spoken
    ['Colombo, Sri Lanka', 'colombo'],
    ['Colombo city', 'colombo'],
    ['Ella, Sri Lanka', 'ella'],
    ['Kandy', 'kandy'],
    ['Nuwara Eliya, Sri Lanka', 'nuwara-eliya'],
    ['  ella  ', 'ella'],                          // case + surrounding space
  ])('%j → %s', (input, id) => {
    expect(T.placeAliasId(input)).toBe(id);
  });
});

describe('placeAliasId — refuses anything that merely CONTAINS a place name', () => {
  it.each([
    'Sigiriya Village Hotel, Sri Lanka',
    'Sigiriya Rock, Sri Lanka',
    'Umbrella Cafe, Ella, Sri Lanka',
    'Ella Flower Garden Resort, Sri Lanka',
    'Galle Face Green, Colombo, Sri Lanka',
    'Kandy City Centre, Sri Lanka',
    'Yala National Park, Sri Lanka',
    'Negombo Beach, Sri Lanka',
    'Colombo Fort Railway Station, Sri Lanka',
    'New Colombo City, Sri Lanka',
    'pasikudah, Kalkudah, Sri Lanka',
  ])('%j → null', (input) => {
    expect(T.placeAliasId(input)).toBeNull();
  });

  it('leaves "Dambulla" unmatched until the owner rules on the 17km gap', () => {
    expect(T.placeAliasId('Dambulla, Sri Lanka')).toBeNull();
    expect(T.placeAliasId('Dambulla Cave Temple, Sri Lanka')).toBeNull();
  });

  it.each([['', null], ['   ', null], [null, null], [undefined, null]])(
    'handles empty input %j', (input) => {
      expect(T.placeAliasId(input)).toBeNull();
    },
  );
});

describe('placeAliasId — every catalogue place can name itself', () => {
  it('round-trips each place through its own name and id', () => {
    for (const p of T.PLACES) {
      expect(T.placeAliasId(p.name), `name: ${p.name}`).toBe(p.id);
      expect(T.placeAliasId(p.id.replace(/-/g, ' ')), `id: ${p.id}`).toBe(p.id);
      expect(T.placeAliasId(`${p.name}, Sri Lanka`), `suffixed: ${p.name}`).toBe(p.id);
    }
  });

  it('never maps two different places onto one alias', () => {
    const seen = new Map();
    for (const p of T.PLACES) {
      for (const alias of [p.name, p.name.replace(/\(.*?\)/g, ''), p.id.replace(/-/g, ' ')]) {
        const key = alias.trim().toLowerCase().replace(/\s+/g, ' ');
        if (!key) continue;
        if (seen.has(key)) expect(seen.get(key), `alias "${key}" is claimed twice`).toBe(p.id);
        seen.set(key, p.id);
      }
    }
  });
});
