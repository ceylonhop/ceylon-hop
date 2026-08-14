import { describe, it, expect } from 'vitest';
import { zoneCoverage, routeHealthRow } from './pricingHealth';
import { RATE_CARD } from './rateCard';
import { quote } from './engine';
import type { HotZone } from './hotZones';
import { KNOWN_PLACES } from '../adapters/maps';

// Fixtures: the five REAL prod hot-zone names that went silently dark (incident 2026-08-14) —
// each saved from a raw Google prediction whose display string never equals a KNOWN_PLACES
// catalogue town, so the D3 matcher (hotZones.ts) never fires for them. Pinned here as a
// regression guard: this report exists specifically to make this class of bug visible.
const SILENT_PROD_ZONES: HotZone[] = [
  { placeName: 'Arugam Bay Beach, Sri Lanka', boostPct: 20, active: true },
  { placeName: 'Ampara town | ... , Ampara, Sri Lanka', boostPct: 15, active: true },
  { placeName: 'Wilpattu National Park, Sri Lanka', boostPct: 15, active: true },
  { placeName: 'Udawalawe National Park, Sri Lanka', boostPct: 15, active: true },
  { placeName: 'Passikuda beach, Kalkudah, Sri Lanka', boostPct: 15, active: true },
];

describe('zoneCoverage', () => {
  it('reports coverage > 0 for a zone whose name exactly matches a catalogue town', () => {
    const zones: HotZone[] = [{ placeName: 'Ella', boostPct: 15, active: true }];
    const [row] = zoneCoverage(zones, KNOWN_PLACES);
    expect(row.placeName).toBe('Ella');
    expect(row.matches).toBeGreaterThan(0);
  });

  it('reports coverage 0 for the five real prod zones saved from raw Google predictions (2026-08-14 incident)', () => {
    const rows = zoneCoverage(SILENT_PROD_ZONES, KNOWN_PLACES);
    expect(rows).toHaveLength(SILENT_PROD_ZONES.length);
    for (const row of rows) {
      expect(row.matches).toBe(0);
    }
  });

  it('"Arugam Bay Beach, Sri Lanka" specifically misses "Arugam Bay" even though the town IS in the catalogue', () => {
    const zones: HotZone[] = [{ placeName: 'Arugam Bay Beach, Sri Lanka', boostPct: 20, active: true }];
    expect(KNOWN_PLACES).toContain('Arugam Bay');
    const [row] = zoneCoverage(zones, KNOWN_PLACES);
    expect(row.matches).toBe(0);
  });
});

describe('routeHealthRow', () => {
  it('flags a floor-bound short leg', () => {
    const row = routeHealthRow('Colombo City', 'Negombo', 5, RATE_CARD, 'estimate');
    expect(row.floorBound).toBe(true);
    expect(row.totalCents).toBe(RATE_CARD.floorCents.car);
    expect(row.ratePerKm).toBeCloseTo(RATE_CARD.floorCents.car / 100 / 5, 6);
  });

  it('does not flag a long leg as floor-bound', () => {
    const row = routeHealthRow('Colombo City', 'Kandy', 250, RATE_CARD, 'estimate');
    expect(row.floorBound).toBe(false);
  });

  it('computes the effective $/km as totalCents / distanceKm, matching a direct engine call', () => {
    const distanceKm = 100;
    const expected = quote(
      { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm }] },
      RATE_CARD,
    );
    const row = routeHealthRow('A', 'B', distanceKm, RATE_CARD, 'estimate');
    expect(row.totalCents).toBe(expected.totalCents);
    expect(row.ratePerKm).toBeCloseTo(expected.totalCents / 100 / distanceKm, 6);
  });

  it('names the zone that fired', () => {
    const zones: HotZone[] = [{ placeName: 'Ella', boostPct: 15, active: true }];
    const rateCard = { ...RATE_CARD, hotZones: zones };
    const row = routeHealthRow('Colombo City', 'Ella', 200, rateCard, 'estimate');
    expect(row.zoneName).toBe('Ella');
  });

  it('has no zone fired when nothing matches', () => {
    const row = routeHealthRow('Colombo City', 'Kandy', 200, RATE_CARD, 'estimate');
    expect(row.zoneName).toBeNull();
  });
});
