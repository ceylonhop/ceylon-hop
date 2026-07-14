import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers, carFare, vanFare } from './_load.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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
    // billableKm = 335 + min(15, round(33.5)) = 350
    // car = max(29, round(350 × 0.4025)) = 141
    // van = max(50, round(350 × 0.5405)) = 189
    expect(q.car).toBe(carFare(335)); // 141
    expect(q.van).toBe(vanFare(335)); // 189
    expect(q.car).toBe(141);
    expect(q.van).toBe(189);
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
    // billableKm = 7 + min 5km buffer = 12
    // car raw = round(12 × 0.4025) = 5  → $29 floor
    // van raw = round(12 × 0.5405) = 6  → $50 floor
    expect(q.car).toBe(29); // floor
    expect(q.van).toBe(50); // floor
  });

  // Regression guard: hill-country must not collapse back to the haversine estimate
  // (~181km), which would under-price it to ~$80; the real 335km drive prices at $149.
  it('REGRESSION: CMB->Ella is priced for the real 335km mountain drive', () => {
    expect(T.privateQuote('cmb-airport', 'ella').car).toBeGreaterThanOrEqual(120);
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

  it('shows popular known places for an empty focused field', () => {
    const labels = T.placeSuggestions('').map((p) => p.label);
    expect(labels.slice(0, 3)).toEqual(['Colombo Airport (CMB)', 'Colombo city', 'Negombo']);
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
  it('deposit is 10% capped at $50, chauffeur day fee is $31.05', () => {
    // engine: RATE_CARD.deposit = { pct: 10, capCents: 5000 }, chauffeur.dayRateCents = 3105 (sell)
    expect(T.DEPOSIT_PCT).toBe(0.10);
    expect(T.DEPOSIT_CAP).toBe(50);
    expect(T.CHAUFFEUR_DAY_FEE).toBe(31.05);
  });

  it('per-km owner rates match the backend rate card (car $0.4025 · van $0.5405)', () => {
    // engine: RATE_CARD.perKmCents = { car: 40.25, van: 54.05 } sell rates (api/src/quote/rateCard.ts).
    // This is the single front-end per-km source: legPrice AND booking.js's chauffeur
    // distance charge both read T.PER_KM, so guarding it here guards both.
    expect(T.PER_KM.car).toBe(0.4025);
    expect(T.PER_KM.van).toBe(0.5405);
  });
});

// Regression guard for the 2026-07-09 chauffeur-distance drift: booking.js:885 once held its
// own hardcoded per-km rate (0.46/0.83) that fell out of sync with the backend and overcharged
// chauffeur-guide trips. It must now derive the rate from the shared TRANSFERS.PER_KM constant,
// never a re-hardcoded number, and the superseded rates must never reappear.
describe('booking.js chauffeur distance rate (no silent drift)', () => {
  const src = readFileSync(path.resolve(__dirname, '../../booking.js'), 'utf8');

  it('reads the per-km rate from the shared TRANSFERS.PER_KM source of truth', () => {
    expect(src).toMatch(/T\.PER_KM/);
  });

  it('does not contain the superseded pre-2026-07-09 per-km rates', () => {
    expect(src).not.toMatch(/\b0\.46\b/);
    expect(src).not.toMatch(/\b0\.83\b/);
  });

  it('sources add-on prices, billable-km logic and deposit from shared helpers/constants (no literals)', () => {
    // add-on prices come from the generated EXTRAS table, billable km from T.billableKm, deposit
    // from DEPOSIT_PCT/CAP — no hand-typed copies that could drift from api/src/quote/rateCard.ts.
    expect(src).toMatch(/window\.TRANSFERS\.EXTRAS/);
    expect(src).toMatch(/T\.billableKm/);
    expect(src).toMatch(/window\.TRANSFERS\.DEPOSIT_PCT/);
    expect(src).not.toMatch(/addonPrices\s*=\s*\{/); // no hand-authored extras table
    expect(src).not.toMatch(/\|\|\s*0\.10\b/); // no hardcoded deposit-pct fallback copy
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
