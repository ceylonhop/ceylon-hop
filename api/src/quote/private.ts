import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { Ride, LineItem } from './types';
import { rideRawKm } from './types';
import { winningZoneForStops, zoneAnnotation } from './hotZones';

function bufferedKm(rawKm: number, rateCard: RateCard): number {
  const unclamped = Math.round(rawKm * (rateCard.bufferPct / 100));
  return Math.min(15, Math.max(5, unclamped));
}

export function billableKm(rawKm: number, rateCard: RateCard = RATE_CARD): number {
  return rawKm + bufferedKm(rawKm, rateCard);
}

// perKmCentsOverride (GL-1d): the operator's custom rate for van14/custom — validated by
// engine.ts before it reaches here; tier floors still apply. `rateCard` defaults to the current
// card; a quote priced against its LOCKED snapshot passes that card in (see the rate-lock spec).
export function legPriceCents(
  distanceKm: number,
  vehicle: Vehicle,
  perKmCentsOverride?: number,
  rateCard: RateCard = RATE_CARD,
): number {
  const rate = perKmCentsOverride ?? rateCard.perKmCents[vehicle];
  const perKm = Math.round(distanceKm * rate);
  return Math.max(rateCard.floorCents[vehicle], perKm);
}

// perRideBoost: the hot-zone multiplier applied to each ride's per-km rate (1 = none), returned so
// the engine can scale the COST basis by the SAME factor (D6 — the boost is a cost, not pure margin).
export function quotePrivateLegs(
  legs: Ride[],
  vehicle: Vehicle,
  perKmCentsOverride?: number,
  rateCard: RateCard = RATE_CARD,
): { lineItems: LineItem[]; subtotalCents: number; warnings: string[]; perRideBoost: number[] } {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  const perRideBoost: number[] = [];
  let subtotalCents = 0;
  const floor = rateCard.floorCents[vehicle];
  const dollars = `$${rateCard.floorCents[vehicle] / 100}`;
  const rate = perKmCentsOverride ?? rateCard.perKmCents[vehicle];

  for (const ride of legs) {
    const rawKm = rideRawKm(ride);
    const bKm = billableKm(rawKm, rateCard);
    // Hot-zone boost: only when NOT a custom-priced tier (D11 — a hand-typed rate is authoritative).
    // A ride touching a zone at any stop uses a boosted per-km rate (D1/D2); the floor still protects
    // short hops (D6). At boost=1 every number below is byte-identical to the pre-hot-zones path.
    const zone = perKmCentsOverride != null ? null : winningZoneForStops(ride.stops, rateCard.hotZones);
    const boost = zone ? 1 + zone.boostPct / 100 : 1;
    perRideBoost.push(boost);
    const perKmCents = Math.round(bKm * rate * boost);
    const amountCents = Math.max(floor, perKmCents);
    // Floor warning uses the BOOSTED per-km amount, or a boosted leg still over the floor misfires.
    if (amountCents === floor && perKmCents < floor) {
      warnings.push(
        ride.stops.length === 2
          ? `${ride.stops[0]}→${ride.stops[1]} hit the ${dollars} ${vehicle} minimum` // byte-exact legacy form
          : `${ride.stops.join(' → ')} hit the ${dollars} ${vehicle} minimum`,
      );
    }
    const meta: Record<string, unknown> = { distanceKm: rawKm, billableKm: bKm, vehicle };
    if (ride.stops.length >= 3) {
      meta.stops = ride.stops;
      meta.segmentKms = ride.segmentKms;
    }
    // Founder-only annotation (D9): rides in meta, stripped for non-margin:view callers. Never a
    // warning. Suppressed on a floored leg where the boost had no effect on the charged amount.
    if (zone && amountCents !== floor) meta.hotZone = zoneAnnotation(zone);
    lineItems.push({ label: `${ride.stops.join(' → ')} (${vehicle})`, amountCents, meta });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents, warnings, perRideBoost };
}
