import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';
import { describe, it, expect } from 'vitest';

// ────────────────────────────────────────────────────────────────────────────
//  A shorthand the DROPDOWN understands must also resolve when it is TYPED.
//
//  Reported by a real customer, 2026-09-22: searching Ella → "Airport" returned
//  no price at all — the honest "we'll price it by hand" card with a WhatsApp
//  button, on a route we sell every day for $140.
//
//  The two halves of the picker disagreed. `rankSuggestion` scores "airport" 95
//  against Colombo Airport (CMB) via `suggestionAliases` (cmb / airport /
//  colombo airport / bandaranaike), so the dropdown offered the right place.
//  `resolvePlaceInput` — what runs when the traveller types and presses the
//  button WITHOUT clicking that row — knew none of those words: it tried an id
//  lookup, then an exact name match, and gave up. So "Airport" travelled to
//  search.html as free text, `T.place()` missed, `engineRoute` went true, and the
//  engine was handed a bare "Airport" that Google cannot place inside Sri Lanka
//  (POST /quote/v2/estimate → 422 quote_unpriced, verified against prod).
//
//  Every layer behaved as designed; they simply held two different vocabularies
//  for one place. One table now, so the word that ranks is the word that resolves.
//
//  This does NOT loosen the matcher: still exact after the country suffix, never
//  a substring (place-alias-id.test.js:14 records why — "Umbrella Cafe" contains
//  "ella"). A hotel that merely starts with "Airport" stays unknown and is priced
//  by the engine, as it should be.
// ────────────────────────────────────────────────────────────────────────────

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '../../');
const DEPS = ['transfers-data.js', 'site.js'].map((f) =>
  readFileSync(path.join(ROOT, f), 'utf8'),
);

function mountSite() {
  const dom = new JSDOM('<!doctype html><body></body>', {
    url: 'https://example.test/index.html',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  DEPS.forEach((src) => {
    const el = dom.window.document.createElement('script');
    el.textContent = src;
    dom.window.document.body.appendChild(el);
  });
  return dom.window;
}

const window = mountSite();
const resolve = (text) => window.resolvePlaceInput(text);

describe('resolvePlaceInput — typing a place\'s own shorthand finds the catalogue place', () => {
  it.each([
    ['Airport', 'cmb-airport'],          // the string the customer's search carried
    ['airport', 'cmb-airport'],
    ['CMB', 'cmb-airport'],              // the other shorthand a traveller types
    ['cmb', 'cmb-airport'],
    ['Colombo Airport', 'cmb-airport'],  // the name without its parenthetical
    ['Bandaranaike', 'cmb-airport'],
    ['Sigiriya', 'sigiriya'],            // catalogue name is "Sigiriya / Dambulla"
    ['Sigiriya, Sri Lanka', 'sigiriya'], // a Google row, typed rather than clicked
    ['Colombo city', 'colombo'],
  ])('%j → %s', (input, id) => {
    const r = resolve(input);
    expect(r.id).toBe(id);
    expect(r.known).toBe(true);
  });

  it('keeps naming the place the way the catalogue does', () => {
    expect(resolve('Airport').name).toBe('Colombo Airport (CMB)');
  });
});

describe('resolvePlaceInput — still refuses anything that merely CONTAINS a place name', () => {
  it.each([
    'Airport Garden Hotel',
    'Colombo Airport Garden Hotel, Sri Lanka',
    'Umbrella Cafe, Ella, Sri Lanka',
    'Sigiriya Village Hotel, Sri Lanka',
  ])('%j stays unknown, for the engine to price', (input) => {
    const r = resolve(input);
    expect(r.known).toBe(false);
    expect(r.id).toBeNull();
    expect(r.name).toBe(input);
  });
});

describe('placeAliasId — the airport shorthands the dropdown already ranks', () => {
  const T = window.TRANSFERS;

  it.each(['Airport', 'CMB', 'airport, Sri Lanka', 'Bandaranaike'])(
    '%j → cmb-airport',
    (input) => {
      expect(T.placeAliasId(input)).toBe('cmb-airport');
    },
  );

  it('ranks and resolves through one vocabulary', () => {
    // Anything `suggestionAliases` offers the dropdown must resolve to the same
    // place when typed — that split is the whole bug.
    for (const q of ['airport', 'cmb', 'colombo airport', 'bandaranaike']) {
      expect(T.placeSuggestions(q, 1)[0].id, `suggested for ${q}`).toBe('cmb-airport');
      expect(T.placeAliasId(q), `resolved for ${q}`).toBe('cmb-airport');
    }
  });
});
