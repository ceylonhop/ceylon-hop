import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, carFare, vanFare } from './_load.js';

let T;
beforeAll(() => { T = loadTransfers(); });

describe('roadKm (distance basis for pricing)', () => {
  it('returns the baked real road distance for a known pair', () => {
    expect(T.roadKm('cmb-airport', 'ella')).toBe(335);
    expect(T.roadKm('cmb-airport', 'kandy')).toBe(118);
    expect(T.roadKm('galle', 'mirissa')).toBe(41);
  });

  it('is symmetric (A->B === B->A)', () => {
    expect(T.roadKm('ella', 'cmb-airport')).toBe(T.roadKm('cmb-airport', 'ella'));
    expect(T.roadKm('kandy', 'ella')).toBe(T.roadKm('ella', 'kandy'));
  });

  it('returns 0 for an unknown id (graceful, not NaN)', () => {
    expect(T.roadKm('cmb-airport', 'no-such-place')).toBe(0);
    expect(T.roadKm('galle', 'galle')).toBe(0);
  });
});

describe('privateQuote (the fare customers see)', () => {
  it('prices car/van from real distance with the agreed formula', () => {
    const q = T.privateQuote('cmb-airport', 'ella');
    expect(q.km).toBe(335);
    expect(q.car).toBe(carFare(335)); // 230
    expect(q.van).toBe(vanFare(335)); // 318
    expect(q.car).toBe(230);
    expect(q.van).toBe(318);
  });

  it('van is always pricier than car', () => {
    for (const [a, b] of [['cmb-airport', 'kandy'], ['galle', 'mirissa'], ['kandy', 'ella']]) {
      const q = T.privateQuote(a, b);
      expect(q.van).toBeGreaterThan(q.car);
    }
  });

  it('uses the REAL drive time (minutes), not a distance-derived estimate', () => {
    // CMB->Ella is 335km but only ~4h57m (highway), not 335/42 = ~8h.
    expect(T.privateQuote('cmb-airport', 'ella').duration).toBe('4h 57m');
  });

  it('honours the minimum fare floors on ultra-short hops', () => {
    const q = T.privateQuote('weligama', 'mirissa'); // 7km
    expect(q.car).toBe(28); // floor
    expect(q.van).toBe(38); // floor
  });

  // Regression guard for this session's fix: hill-country must not collapse back to
  // the haversine estimate that under-priced it ($134).
  it('REGRESSION: CMB->Ella is priced for the real 335km mountain drive', () => {
    expect(T.privateQuote('cmb-airport', 'ella').car).toBeGreaterThanOrEqual(200);
  });
});

describe('legPrice', () => {
  it('matches the privateQuote formula for the same distance', () => {
    expect(T.legPrice(335, 'car')).toBe(carFare(335));
    expect(T.legPrice(335, 'van')).toBe(vanFare(335));
  });
  it('returns null for unknown distance', () => {
    expect(T.legPrice(null, 'car')).toBeNull();
  });
});

describe('kmBetween (planner / typed-place distance)', () => {
  it('uses the baked table for known ids', () => {
    expect(T.kmBetween('cmb-airport', 'ella')).toBe(335);
  });
  it('resolves display names to the baked table', () => {
    expect(T.kmBetween('Colombo Airport (CMB)', 'Ella')).toBe(335);
  });
  it('returns null when a place cannot be resolved', () => {
    expect(T.kmBetween('cmb-airport', 'Some Unknown Place XYZ')).toBeNull();
  });
});

describe('tripQuote (multi-stop)', () => {
  it('sums real-distance leg fares', () => {
    const stops = ['cmb-airport', 'kandy', 'ella'];
    const q = T.tripQuote(stops, 'car');
    const expected = T.legPrice(T.kmBetween('cmb-airport', 'kandy'), 'car')
                   + T.legPrice(T.kmBetween('kandy', 'ella'), 'car');
    expect(q.total).toBe(expected);
    expect(q.totalKm).toBe(T.kmBetween('cmb-airport', 'kandy') + T.kmBetween('kandy', 'ella'));
  });
  it('van total exceeds car total', () => {
    const stops = ['cmb-airport', 'kandy', 'ella'];
    expect(T.tripQuote(stops, 'van').total).toBeGreaterThan(T.tripQuote(stops, 'car').total);
  });
});

describe('sharedOption (corridor seats)', () => {
  it('finds a corridor when both stops share one', () => {
    const s = T.sharedOption('mirissa', 'galle');
    expect(s).toBeTruthy();
    expect(s.corridorId).toBeTruthy();
    expect(s.seat).toBeGreaterThan(0);
  });
  it('returns null when the pair is not on any corridor', () => {
    expect(T.sharedOption('cmb-airport', 'arugam-bay')).toBeNull();
    expect(T.sharedOption('galle', 'galle')).toBeNull();
  });
});
