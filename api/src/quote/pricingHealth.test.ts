import { describe, it, expect } from 'vitest';
import { zoneCoverage, routeHealthRow, buildDistanceIndex, lookupDistance, rankRouteHealth } from './pricingHealth';
import { RATE_CARD } from './rateCard';
import { quote } from './engine';
import type { HotZone } from './hotZones';
import { KNOWN_PLACES, canonPlace } from '../adapters/maps';
import type { DistanceCacheRepo, DistanceCacheRow } from '../db/distanceCacheRepo';

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

// Fake repo whose all()/get() call counts we can inspect — pins that the report loads the cache
// ONCE (defect: it was calling repo.get() once per route pair — 1,406 calls against a remote
// Supabase pooler, which hangs past 3 minutes).
function countingFakeRepo(rows: DistanceCacheRow[]): DistanceCacheRepo & { allCalls: number; getCalls: number } {
  return {
    allCalls: 0,
    getCalls: 0,
    async all(): Promise<DistanceCacheRow[]> {
      this.allCalls++;
      return rows;
    },
    async get(): Promise<DistanceCacheRow | null> {
      this.getCalls++;
      return null;
    },
    async upsert(): Promise<DistanceCacheRow> {
      throw new Error('upsert not used by pricing-health');
    },
  };
}

describe('buildDistanceIndex / lookupDistance', () => {
  it('loads the whole cache via a single all() call, then every lookup is local (get() never called)', async () => {
    const cached: DistanceCacheRow = {
      fromKey: canonPlace('Colombo City'),
      toKey: canonPlace('Kandy'),
      km: 115,
      durationMin: 180,
      source: 'google',
      fetchedAt: new Date(),
    };
    const repo = countingFakeRepo([cached]);
    const index = await buildDistanceIndex(repo);
    // simulate looking up many route pairs, as the script does across the whole catalogue
    for (let i = 0; i < 50; i++) {
      lookupDistance(index, 'Colombo City', 'Kandy');
      lookupDistance(index, 'Colombo City', 'Galle');
    }
    expect(repo.allCalls).toBe(1);
    expect(repo.getCalls).toBe(0);
  });

  it('finds a cached row by canonicalised from/to, and misses a pair not in the cache', async () => {
    const cached: DistanceCacheRow = {
      fromKey: canonPlace('Colombo City'),
      toKey: canonPlace('Kandy'),
      km: 115,
      durationMin: 180,
      source: 'google',
      fetchedAt: new Date(),
    };
    const index = await buildDistanceIndex(countingFakeRepo([cached]));
    expect(lookupDistance(index, 'Colombo City', 'Kandy')?.km).toBe(115);
    expect(lookupDistance(index, 'Kandy', 'Colombo City')).toBeNull(); // directional, per distanceCacheRepo
    expect(lookupDistance(index, 'Colombo City', 'Galle')).toBeNull();
  });
});

describe('rankRouteHealth', () => {
  const expectedPerKm = RATE_CARD.perKmCents.car / 100;

  it('excludes floor-bound routes from the ranked list and reports them as a separate count with the shortest example', () => {
    const rows = [
      routeHealthRow('Colombo City', 'Negombo', 5, RATE_CARD, 'estimate'), // floor-bound, 5km
      routeHealthRow('Galle', 'Unawatuna', 3, RATE_CARD, 'estimate'), // floor-bound, shorter
      routeHealthRow('Colombo City', 'Kandy', 250, RATE_CARD, 'estimate'), // not floor-bound
    ];
    const { ranked, floorBound } = rankRouteHealth(rows, expectedPerKm);

    expect(ranked).toHaveLength(1);
    expect(ranked.every((r) => !r.floorBound)).toBe(true);
    expect(ranked[0].route).toBe('Colombo City → Kandy');

    expect(floorBound.count).toBe(2);
    expect(floorBound.shortest?.route).toBe('Galle → Unawatuna');
    expect(floorBound.shortest?.distanceKm).toBe(3);
  });

  it('ranks a zone-boosted route above an ordinary route of the same distance (the point of the report)', () => {
    const zones: HotZone[] = [{ placeName: 'Ella', boostPct: 25, active: true }];
    const boostedCard = { ...RATE_CARD, hotZones: zones };
    const boosted = routeHealthRow('Colombo City', 'Ella', 200, boostedCard, 'estimate');
    const ordinary = routeHealthRow('Colombo City', 'Kandy', 200, RATE_CARD, 'estimate');

    // sanity: the ordinary route prices at (roughly) the card's expected $/km, the boosted one well above
    expect(ordinary.ratePerKm).toBeCloseTo(expectedPerKm, 1);
    expect(boosted.ratePerKm).toBeGreaterThan(ordinary.ratePerKm);

    const { ranked } = rankRouteHealth([ordinary, boosted], expectedPerKm);
    expect(ranked[0].route).toBe(boosted.route);
    expect(ranked[0].zoneName).toBe('Ella');
  });
});
