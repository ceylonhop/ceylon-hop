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
  it('prices car/van from real distance with the engine rate-card formula', () => {
    const q = T.privateQuote('cmb-airport', 'ella');
    expect(q.km).toBe(335);
    // billableKm = round(335 × 1.10) = round(368.5) = 369
    // car = max(29, round(369 × 0.46)) = round(169.74) = 170
    // van = max(50, round(369 × 0.83)) = round(306.27) = 306
    expect(q.car).toBe(carFare(335)); // 170
    expect(q.van).toBe(vanFare(335)); // 306
    expect(q.car).toBe(170);
    expect(q.van).toBe(306);
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
    // billableKm = round(7 × 1.10) = 8
    // car raw = round(8 × 0.46) = round(3.68) = 4  → $29 floor
    // van raw = round(8 × 0.83) = round(6.64) = 7  → $50 floor
    expect(q.car).toBe(29); // floor
    expect(q.van).toBe(50); // floor
  });

  // Regression guard: hill-country must not collapse back to the haversine estimate
  // (~181km), which would under-price it to ~$92; the real 335km drive prices at $170.
  it('REGRESSION: CMB->Ella is priced for the real 335km mountain drive', () => {
    expect(T.privateQuote('cmb-airport', 'ella').car).toBeGreaterThanOrEqual(150);
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

describe('placeSuggestions (planner hybrid autocomplete)', () => {
  it('ranks Colombo Airport above Colombo city for CMB and airport queries', () => {
    expect(T.placeSuggestions('cmb')[0].label).toBe('Colombo Airport (CMB)');
    expect(T.placeSuggestions('airport')[0].label).toBe('Colombo Airport (CMB)');
  });

  it('returns known places before extras for broad matches', () => {
    const labels = T.placeSuggestions('col').map((p) => p.label);
    expect(labels.indexOf('Colombo Airport (CMB)')).toBeLessThan(labels.indexOf('Colombo city'));
    expect(labels).toContain('Colombo city');
  });

  it('keeps hotel searches focused on the matching city instead of broad route suggestions', () => {
    const labels = T.placeSuggestions('hilton colombo').map((p) => p.label);
    expect(labels[0]).toBe('Colombo city');
    expect(labels).not.toContain('Galle');
    expect(T.kmBetween('Sigiriya / Dambulla', 'hilton colombo')).toBeNull();
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

describe('chauffeur + deposit constants (engine parity)', () => {
  it('deposit is 10% capped at $50, chauffeur day fee stays $35', () => {
    // engine: RATE_CARD.deposit = { pct: 10, capCents: 5000 }, chauffeur.dayRateCents = 3500
    expect(T.DEPOSIT_PCT).toBe(0.10);
    expect(T.DEPOSIT_CAP).toBe(50);
    expect(T.CHAUFFEUR_DAY_FEE).toBe(35);
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
