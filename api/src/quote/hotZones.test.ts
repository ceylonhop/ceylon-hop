import { describe, it, expect } from 'vitest';
import { zoneBoostFor, zoneBoostForStops, type HotZone } from './hotZones';

const ella = (pct = 15, extra: Partial<HotZone> = {}): HotZone => ({ placeName: 'Ella', boostPct: pct, ...extra });
const galle = (pct = 10): HotZone => ({ placeName: 'Galle', boostPct: pct });

describe('zoneBoostFor — D3 matching algorithm', () => {
  // Worked-examples table from the spec (§3, D3) — verbatim.
  it('exact match: Ella zone, "Ella" endpoint', () => {
    expect(zoneBoostFor('Ella', undefined, [ella(15)])).toBeCloseTo(1.15);
  });
  it('case/space insensitive: "  ella " matches Ella', () => {
    expect(zoneBoostFor('  ella ', undefined, [ella(15)])).toBeCloseTo(1.15);
  });
  it('address-component fallback: "Nine Arch Bridge, Ella, Sri Lanka" matches Ella', () => {
    expect(zoneBoostFor('Nine Arch Bridge, Ella, Sri Lanka', undefined, [ella(15)])).toBeCloseTo(1.15);
  });
  it('no false substring: "Bella Vista Hotel, Colombo" does NOT match Ella', () => {
    expect(zoneBoostFor('Bella Vista Hotel, Colombo', undefined, [ella(15)])).toBe(1);
  });
  it('Galle does NOT match "Galle Face Green, Colombo" (component is "Galle Face Green")', () => {
    expect(zoneBoostFor('Galle Face Green, Colombo', undefined, [galle(10)])).toBe(1);
  });
  it('Galle matches "Galle Fort, Galle" via address component', () => {
    expect(zoneBoostFor('Galle Fort, Galle', undefined, [galle(10)])).toBeCloseTo(1.1);
  });
  it('compound known-place split: "Sigiriya / Dambulla" zone matches "Dambulla" endpoint', () => {
    const z: HotZone = { placeName: 'Sigiriya / Dambulla', boostPct: 20 };
    expect(zoneBoostFor('Dambulla', undefined, [z])).toBeCloseTo(1.2);
    expect(zoneBoostFor('Sigiriya', undefined, [z])).toBeCloseTo(1.2);
  });
  it('parenthetical strip: "Colombo Airport (CMB)" zone matches "Colombo Airport" endpoint', () => {
    const z: HotZone = { placeName: 'Colombo Airport (CMB)', boostPct: 12 };
    expect(zoneBoostFor('Colombo Airport', undefined, [z])).toBeCloseTo(1.12);
  });
  it('airport ≠ city: "Colombo City" zone does NOT match "Colombo Airport (CMB)"', () => {
    const z: HotZone = { placeName: 'Colombo City', boostPct: 12 };
    expect(zoneBoostFor('Colombo Airport (CMB)', undefined, [z])).toBe(1);
  });
});

describe('zoneBoostFor — active flag, stacking, radius', () => {
  it('inactive zones are skipped', () => {
    expect(zoneBoostFor('Ella', undefined, [ella(15, { active: false })])).toBe(1);
    expect(zoneBoostFor('Ella', undefined, [ella(15, { active: true })])).toBeCloseTo(1.15);
  });
  it('D7 stacking: two matching zones apply the MAX, never the sum', () => {
    const zones: HotZone[] = [ella(15), { placeName: 'Ella', boostPct: 25 }];
    expect(zoneBoostFor('Ella', undefined, zones)).toBeCloseTo(1.25); // max, not 1.40
  });
  it('no zones / undefined → 1 (no boost)', () => {
    expect(zoneBoostFor('Ella', undefined, [])).toBe(1);
    expect(zoneBoostFor('Ella', undefined, undefined)).toBe(1);
  });
  it('0% zone → multiplier of 1', () => {
    expect(zoneBoostFor('Ella', undefined, [ella(0)])).toBe(1);
  });
  it('radius fallback: coords within radius match even when the name misses', () => {
    // Ella is at [6.87, 81.05]; a nearby GPS point Google labels as a village.
    const z: HotZone = { placeName: 'Ella', boostPct: 15, lat: 6.87, lng: 81.05, radiusKm: 10 };
    expect(zoneBoostFor('Demodara Village', [6.88, 81.06], [z])).toBeCloseTo(1.15);
    expect(zoneBoostFor('Demodara Village', [6.5, 80.5], [z])).toBe(1); // ~60km away → no match
  });
  it('radius trio absent → name-only (no coords crash)', () => {
    expect(zoneBoostFor('Somewhere', [6.87, 81.05], [ella(15)])).toBe(1);
  });
});

describe('zoneBoostForStops — max over all stops of a ride/day (D2 any-touch)', () => {
  it('any stop touching a zone boosts the whole ride (max over stops)', () => {
    const zones = [ella(15)];
    expect(zoneBoostForStops(['Kandy', 'Ella'], zones)).toBeCloseTo(1.15);
    expect(zoneBoostForStops(['Kandy', 'Nuwara Eliya'], zones)).toBe(1);
  });
  it('multiple stops in different zones → the single largest boost (D7)', () => {
    const zones = [ella(15), galle(25)];
    expect(zoneBoostForStops(['Galle', 'Ella'], zones)).toBeCloseTo(1.25);
  });
});
