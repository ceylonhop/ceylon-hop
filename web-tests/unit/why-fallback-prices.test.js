import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTransfers } from './_load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const why = readFileSync(path.resolve(__dirname, '../../why.html'), 'utf8');

/* why.html's comparison panel is written into the HTML as static text and then overwritten by
   inline JS from TRANSFERS — the same source the booking flow prices from. Everyone running JS
   sees live numbers, so the static text is invisible to them and can rot unnoticed: it sat at
   "$75 fixed / or shared seat $19" while the real quote was $49.99 with no shared seat on that
   route at all. Whoever still reads the static markup — a crawler, a reader with JS off, a
   preview card — was being shown a 50% overstatement and a product we do not sell there.

   So the fallback is pinned to the same data the JS uses. If the rate card moves, this fails
   and the markup gets updated with it. */
describe('why.html no-JS comparison fallback', () => {
  const ROUTE = ['cmb-airport', 'kandy'];

  it('quotes the same private car price the JS would render', () => {
    const T = loadTransfers();
    const q = T.privateQuote(...ROUTE);
    const shown = /id="cmp-car">\$([0-9.]+) fixed</.exec(why);
    expect(shown, 'cmp-car fallback not found in why.html').toBeTruthy();
    expect(shown[1]).toBe(String(q.car));
  });

  it('derives the taxi comparison from that price, exactly as the JS does', () => {
    const T = loadTransfers();
    const q = T.privateQuote(...ROUTE);
    const expected = Math.round((q.car * 1.6) / 5) * 5;
    const shown = /id="cmp-taxi">\$([0-9.]+)\?</.exec(why);
    expect(shown, 'cmp-taxi fallback not found in why.html').toBeTruthy();
    expect(Number(shown[1])).toBe(expected);
  });

  it('advertises a shared seat only where one actually runs', () => {
    const T = loadTransfers();
    const shared = T.sharedOption(...ROUTE);
    const seat = /id="cmp-seat"[^>]*>([^<]*)</.exec(why);
    expect(seat, 'cmp-seat element not found in why.html').toBeTruthy();
    if (shared) {
      expect(seat[1]).toContain(String(shared.seat));
    } else {
      // No shared service on this corridor — the static markup must not promise one.
      expect(seat[1].trim()).toBe('');
    }
  });
});
