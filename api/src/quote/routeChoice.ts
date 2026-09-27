// Customer route choice (spec 2026-09-26-customer-route-choice-design.md §4.1).
//
// The server is the only thing that ever measures a road: a customer page may ASK for the
// toll-free road, but its km always comes from distanceVariants() here, never from the client.
// The main distance keeps coming from maps.distance() — the call that flags an offline
// (crow-flies) estimate — because distanceVariants().fastest silently falls back to that same
// estimate without the flag (maps.ts offlineEstimate). Only `noTolls` is taken from the
// comparison, and it only exists when BOTH Google answers succeeded with a material gap.
import type { DistanceResult, MapsAdapter } from '../adapters/maps';

export const ROUTE_VARIANTS = ['fastest', 'no_tolls'] as const;
export type RouteVariant = (typeof ROUTE_VARIANTS)[number];

export interface MeasuredLeg {
  km: number;
  durationMin: number;
  estimated?: boolean;
  /** The road actually measured — 'fastest' whenever a requested local road couldn't be confirmed. */
  variant: RouteVariant;
}

export async function measureLeg(
  maps: MapsAdapter,
  from: string,
  to: string,
  want?: RouteVariant,
): Promise<MeasuredLeg | null> {
  const fastest = await maps.distance(from, to);
  if (!fastest) return null;
  const onFastest: MeasuredLeg = { ...fastest, variant: 'fastest' };
  if (want !== 'no_tolls' || fastest.estimated) return onFastest;
  const v = await maps.distanceVariants(from, to).catch(() => null);
  if (!v || !v.hasChoice || !v.noTolls) return onFastest;
  return { km: v.noTolls.km, durationMin: v.noTolls.durationMin, variant: 'no_tolls' };
}

export interface RouteChoiceSide {
  distanceKm: number;
  durationMin: number;
  totalCents: number;
}
export interface RouteChoice {
  fastest: RouteChoiceSide;
  noTolls: RouteChoiceSide;
}

// Both roads, priced, ONLY when the toll-free one is genuinely cheaper. The ops fork test
// (isMaterialRouteChoice) takes an absolute km gap, so it also flags a toll-free road that is
// longer AND slower; a customer is only ever offered a saving (spec §4.1 "Cheaper, not just
// different"). A pair on the vehicle floor fare prices the same both ways and is never offered.
// Server-side cap on compared intents per estimate-batch: each comparison is two Google elements,
// and a plan holds at most 10 drives (spec §7). Intents past the cap are priced but not compared.
export const MAX_COMPARE_PER_BATCH = 12;

export async function cheaperRouteChoice(
  maps: MapsAdapter,
  from: string,
  to: string,
  fastest: DistanceResult,
  priceAtKm: (km: number) => number,
): Promise<RouteChoice | null> {
  if (fastest.estimated) return null;
  const v = await maps.distanceVariants(from, to).catch(() => null);
  if (!v || !v.hasChoice || !v.noTolls) return null;
  const fastCents = priceAtKm(fastest.km);
  const slowCents = priceAtKm(v.noTolls.km);
  if (!(slowCents < fastCents)) return null;
  return {
    fastest: { distanceKm: fastest.km, durationMin: fastest.durationMin, totalCents: fastCents },
    noTolls: { distanceKm: v.noTolls.km, durationMin: v.noTolls.durationMin, totalCents: slowCents },
  };
}
