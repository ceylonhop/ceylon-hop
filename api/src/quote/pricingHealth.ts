// Pricing health — pure, tested logic behind scripts/pricing-health.ts (owner incident
// 2026-08-14: 8 hot zones active in prod, only 3 actually fired; the other 5 were saved from raw
// Google predictions whose display strings never equal a KNOWN_PLACES catalogue town, so the D3
// matcher in hotZones.ts silently never boosted a single quote). This module answers two
// questions offline and deterministically:
//   1. zoneCoverage  — per zone, how many catalogue routes does it actually WIN (via the real
//      matcher, winningZoneForStops)? A zone with 0 is the incident happening again.
//   2. routeHealthRow — per route, the effective sell $/km, whether it's floor-bound (so a short
//      leg's naturally-high $/km isn't misread as a pricing bug), and which zone (if any) fired.
import { winningZoneForStops, type HotZone } from './hotZones';
import type { RateCard, Vehicle } from './rateCard';
import { quote } from './engine';

export interface ZoneCoverageRow {
  placeName: string;
  boostPct: number;
  active: boolean;
  matches: number;
}

// One row per input zone: the count of ordered (from, to) pairs over `places` for which this
// zone is the WINNING zone (winningZoneForStops — the same matcher the engine prices with, so
// this measures "actually fires", not "the alias merely overlaps"). `places` is normally the
// KNOWN_PLACES catalogue, but is a parameter so the module stays DB/adapter-free and testable.
export function zoneCoverage(zones: HotZone[], places: string[]): ZoneCoverageRow[] {
  const counts = new Map<HotZone, number>(zones.map((z) => [z, 0]));
  for (const from of places) {
    for (const to of places) {
      if (from === to) continue;
      const winner = winningZoneForStops([from, to], zones);
      if (winner) counts.set(winner, (counts.get(winner) ?? 0) + 1);
    }
  }
  return zones.map((z) => ({
    placeName: z.placeName,
    boostPct: z.boostPct,
    active: z.active !== false,
    matches: counts.get(z) ?? 0,
  }));
}

export type DistanceSource = 'cache' | 'estimate';

export interface RouteHealthRow {
  route: string; // "From → To"
  distanceKm: number;
  totalCents: number;
  ratePerKm: number; // effective sell rate: totalCents / 100 / distanceKm
  floorBound: boolean; // the leg priced at (or below) the vehicle floor — a short-leg false alarm
  zoneName: string | null; // the hot zone that fired for this route, if any (winningZoneForStops)
  source: DistanceSource;
}

const VEHICLE: Vehicle = 'car';

// Prices one ordered route the way the real engine would (private, car, pax 2, bags 2, no
// extras — the report's fixed sampling point), and reports its effective $/km, floor-bound
// status, and which zone (if any) fired. `distanceKm` and `rateCard` are supplied by the caller
// (script) so this stays a pure function of its inputs — no DB, no maps adapter, no clock.
export function routeHealthRow(
  from: string,
  to: string,
  distanceKm: number,
  rateCard: RateCard,
  source: DistanceSource,
): RouteHealthRow {
  const result = quote(
    { product: 'private', vehicle: VEHICLE, pax: 2, bags: 2, legs: [{ from, to, distanceKm }] },
    rateCard,
  );
  const leg = result.lineItems[0];
  // The leg's pre-finishing amount is exactly Math.max(floor, perKmCents) (quotePrivateLegs); a
  // floor-bound leg can never price BELOW the floor, so equality is the correct — not just
  // approximate — test.
  const floorBound = leg.amountCents <= rateCard.floorCents[VEHICLE];
  const zone = winningZoneForStops([from, to], rateCard.hotZones);
  return {
    route: `${from} → ${to}`,
    distanceKm,
    totalCents: result.totalCents,
    ratePerKm: distanceKm > 0 ? result.totalCents / 100 / distanceKm : 0,
    floorBound,
    zoneName: zone ? zone.placeName : null,
    source,
  };
}
