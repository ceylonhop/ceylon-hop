// Pricing health — a standing detector for the 2026-08-14 hot-zone incident: 8 zones were active
// in prod, but only 3 actually fired ("<Town>, Sri Lanka" — an exact catalogue match). The other
// 5 were saved from raw Google predictions ("Arugam Bay Beach, Sri Lanka", "Wilpattu National
// Park, Sri Lanka", …) whose display strings never equal a KNOWN_PLACES catalogue town, so the D3
// matcher (src/quote/hotZones.ts) silently never boosted a single quote — for weeks, with no
// signal. Run this periodically. A zone with 0 route matches in Section 1 is that bug recurring.
//
//   npx tsx scripts/pricing-health.ts                              # offline: no zones, estimated distances
//   DATABASE_URL='postgres://…' npx tsx scripts/pricing-health.ts  # real active zones + cached distances
//
// Offline and free by construction: this script NEVER calls Google. Distances come from the
// distance_cache table when a DATABASE_URL is supplied (a pair missing from the cache falls back
// to the offline estimate, marked); without one, every pair uses the offline crow-flies estimate
// (FakeMapsAdapter). Every route is priced through the real engine (quote()) with a card composed
// by liveRateCard, so the numbers below are exactly what a live quote would produce.
//
// DELIBERATELY does NOT load api/.env — see scripts/promote-audit.ts for why: that file holds the
// PRODUCTION DATABASE_URL, and a script that picks it up implicitly is one typo away from pointing
// at prod when you meant staging. Pass the URL explicitly, as above.
import { KNOWN_PLACES, FakeMapsAdapter } from '../src/adapters/maps';
import { createDb } from '../src/db/client';
import { InMemoryZonesRepo, type ZonesRepo } from '../src/db/zonesRepo';
import { PostgresZonesRepo } from '../src/db/postgresZonesRepo';
import { PostgresDistanceCacheRepo } from '../src/db/postgresDistanceCacheRepo';
import type { DistanceCacheRepo, DistanceCacheRow } from '../src/db/distanceCacheRepo';
import { liveRateCard } from '../src/quote/liveCard';
import { RATE_CARD } from '../src/quote/rateCard';
import {
  zoneCoverage,
  routeHealthRow,
  buildDistanceIndex,
  lookupDistance,
  rankRouteHealth,
  type RouteHealthRow,
} from '../src/quote/pricingHealth';

const TOP_N = 40;

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  const zonesRepo: ZonesRepo = databaseUrl ? new PostgresZonesRepo(createDb(databaseUrl).db) : new InMemoryZonesRepo();
  const distanceRepo: DistanceCacheRepo | null = databaseUrl ? new PostgresDistanceCacheRepo(createDb(databaseUrl).db) : null;
  const maps = new FakeMapsAdapter();

  const rateCard = await liveRateCard(zonesRepo, RATE_CARD);
  const zones = rateCard.hotZones ?? [];

  console.log(`# Pricing health — ${new Date().toISOString().slice(0, 10)}\n`);
  if (!databaseUrl) {
    console.log(
      'No DATABASE_URL supplied — running offline: no zones loaded, distances are the offline ' +
        'crow-flies estimate (FakeMapsAdapter). Pass DATABASE_URL to check real active zones against ' +
        'the distance cache.\n',
    );
  }

  // ── Section 1: zone coverage (the headline) ──────────────────────────────────────────────
  console.log('## Zone coverage\n');
  const coverage = zoneCoverage(zones, KNOWN_PLACES);
  if (coverage.length === 0) {
    console.log('No active zones.\n');
  } else {
    console.log('| Zone | Boost | Routes matched |');
    console.log('|---|---|---|');
    for (const row of coverage) {
      const flag = row.matches === 0 ? ' ⚠ NEVER FIRES' : '';
      console.log(`| ${row.placeName} | +${row.boostPct}% | ${row.matches}${flag} |`);
    }
    console.log('');
  }

  // ── Section 2: route table, real anomalies first ──────────────────────────────────────────
  // Load the WHOLE distance cache ONCE (a per-route repo.get() over 1,406 pairs hung past 3
  // minutes against a remote Supabase pooler) and look every pair up locally.
  const distanceIndex: Map<string, DistanceCacheRow> = distanceRepo ? await buildDistanceIndex(distanceRepo) : new Map();
  const rows: RouteHealthRow[] = [];
  for (const from of KNOWN_PLACES) {
    for (const to of KNOWN_PLACES) {
      if (from === to) continue;
      const cached = lookupDistance(distanceIndex, from, to);
      if (cached) {
        rows.push(routeHealthRow(from, to, cached.km, rateCard, 'cache'));
        continue;
      }
      const est = await maps.distance(from, to);
      if (!est) continue; // shouldn't happen for two KNOWN_PLACES, but never crash the report
      rows.push(routeHealthRow(from, to, est.km, rateCard, 'estimate'));
    }
  }

  // Floor-bound routes (the vehicle minimum applies) are expected, not anomalous — a short-leg
  // false alarm that used to fill the top of this table. They're reported as a count + the most
  // extreme (shortest) example instead of ranked alongside real signal.
  // routeHealthRow always prices with the 'car' vehicle (its fixed sampling point).
  const expectedPerKm = RATE_CARD.perKmCents.car / 100;
  const { ranked, floorBound } = rankRouteHealth(rows, expectedPerKm);
  const shown = ranked.slice(0, TOP_N);

  console.log('## Route table — anomalies (ranked by deviation from the rate card\'s expected $/km)\n');
  if (floorBound.count > 0 && floorBound.shortest) {
    console.log(
      `${floorBound.count} routes are floor-bound (minimum fare applies) — shortest: ` +
        `${floorBound.shortest.route} at ${floorBound.shortest.distanceKm}km\n`,
    );
  }
  console.log(`Top ${shown.length} of ${ranked.length} non-floor-bound routes, expected $/km = $${expectedPerKm.toFixed(2)}\n`);
  console.log('| Route | $/km | Deviation | Floor-bound? | Zone fired | Source |');
  console.log('|---|---|---|---|---|---|');
  for (const r of shown) {
    const deviation = r.ratePerKm - expectedPerKm;
    console.log(
      `| ${r.route} | $${r.ratePerKm.toFixed(2)} | ${deviation >= 0 ? '+' : ''}$${deviation.toFixed(2)} | ${r.floorBound ? '⚠ floor' : ''} | ${r.zoneName ?? ''} | ${r.source} |`,
    );
  }
  if (ranked.length > shown.length) {
    console.log(`\n…and ${ranked.length - shown.length} more routes not shown.`);
  }
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
