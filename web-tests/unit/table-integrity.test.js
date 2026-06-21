import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, PLACE_IDS } from './_load.js';

let T;
beforeAll(() => { T = loadTransfers(); });

describe('baked real-distance table integrity', () => {
  it('covers every place pair (all 120) with a sane, symmetric distance', () => {
    let pairs = 0;
    for (let i = 0; i < PLACE_IDS.length; i++) {
      for (let j = i + 1; j < PLACE_IDS.length; j++) {
        const a = PLACE_IDS[i], b = PLACE_IDS[j];
        const km = T.roadKm(a, b);
        pairs++;
        expect(km, `${a}->${b}`).toBeGreaterThan(0);
        expect(km, `${a}->${b}`).toBeLessThan(600);
        expect(T.roadKm(b, a), `${b}->${a} symmetry`).toBe(km);
      }
    }
    expect(pairs).toBe(120); // 16 choose 2
  });

  it('every place id resolves to a real catalogue place', () => {
    for (const id of PLACE_IDS) {
      expect(T.place(id), id).toBeTruthy();
    }
  });

  // Lock specific baked values so an accidental table edit is caught immediately.
  it('locks spot-check distances (km)', () => {
    const expected = {
      'cmb-airport|ella': 335,
      'cmb-airport|kandy': 118,
      'cmb-airport|galle': 153,
      'kandy|ella': 136,
      'kandy|nuwara-eliya': 76,
      'galle|mirissa': 41,
      'yala|arugam-bay': 192,
      'anuradhapura|trincomalee': 108,
      'weligama|mirissa': 7,
    };
    for (const [pair, km] of Object.entries(expected)) {
      const [a, b] = pair.split('|');
      expect(T.roadKm(a, b), pair).toBe(km);
    }
  });

  it('baked durations differ from the naive km/42 estimate (real minutes are used)', () => {
    // Mountain routes are faster than km/42 (highway sections); coastal slower.
    expect(T.privateQuote('cmb-airport', 'ella').duration).toBe('4h 57m');
    expect(T.privateQuote('kandy', 'ella').duration).toBe('3h 47m');
  });
});
