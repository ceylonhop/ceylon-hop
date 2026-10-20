import { describe, it, expect } from 'vitest';
import { loadTransfers } from '../../tools/load-transfers.mjs';
import { loadContent } from '../../tools/generate-route-pages.mjs';

const content = loadContent();
const PAIRS = [
  ['cmb-airport','kandy'],['cmb-airport','sigiriya'],['cmb-airport','galle'],['cmb-airport','mirissa'],
  ['cmb-airport','ella'],['cmb-airport','negombo'],['cmb-airport','colombo'],['negombo','sigiriya'],
  ['negombo','kandy'],['colombo','kandy'],['colombo','galle'],['colombo','ella'],['sigiriya','kandy'],
  ['kandy','ella'],['kandy','nuwara-eliya'],['nuwara-eliya','ella'],['ella','yala'],['ella','arugam-bay'],
  ['ella','mirissa'],['yala','mirissa'],['mirissa','galle'],['galle','ella'],
  ['cmb-airport','hiriketiya'],['ella','hiriketiya'],['yala','hiriketiya'],
];

describe('route-content.json', () => {
  const T = loadTransfers();
  it('has a blurb for every place used by a pair', () => {
    const ids = new Set(PAIRS.flat());
    for (const id of ids) {
      expect(content.places[id], `place ${id}`).toBeTruthy();
      expect(content.places[id].short.length).toBeGreaterThan(20);
      expect(T.byId[id], `place ${id} is a real place id`).toBeTruthy();
    }
  });
  // A pair missing from REAL_KM silently prices off straight-line distance x 1.35 and prints
  // "estimated" on its trip page — every corridor needs its baked Google road distance.
  it('prices every pair off a baked road distance, never a straight-line estimate', () => {
    for (const [a,b] of PAIRS) expect(T.privateQuote(a, b).estimated, `pair ${a}|${b}`).toBe(false);
  });
  it('has an intro + back + >=3 highlights for every pair', () => {
    for (const [a,b] of PAIRS) {
      const p = content.pairs[`${a}|${b}`];
      expect(p, `pair ${a}|${b}`).toBeTruthy();
      expect(p.intro.length).toBeGreaterThan(120);
      expect(p.back.length).toBeGreaterThan(60);
      expect(Array.isArray(p.highlights) && p.highlights.length >= 3).toBe(true);
    }
  });
  it('never hardcodes a price in prose (the generator injects prices)', () => {
    for (const [, p] of Object.entries(content.pairs)) {
      for (const s of [p.intro, p.back, ...p.highlights]) {
        expect(s, `price leak in "${s.slice(0,40)}"`).not.toMatch(/\$|\bUSD\b|dollar/i);
      }
    }
  });
});
