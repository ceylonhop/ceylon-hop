import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { Ride, LineItem } from './types';
import { rideRawKm } from './types';

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

export function quotePrivateLegs(
  legs: Ride[],
  vehicle: Vehicle,
  perKmCentsOverride?: number,
  rateCard: RateCard = RATE_CARD,
): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] } {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  const floor = rateCard.floorCents[vehicle];
  const dollars = `$${rateCard.floorCents[vehicle] / 100}`;
  const rate = perKmCentsOverride ?? rateCard.perKmCents[vehicle];

  for (const ride of legs) {
    const rawKm = rideRawKm(ride);
    const bKm = billableKm(rawKm, rateCard);
    const amountCents = legPriceCents(bKm, vehicle, perKmCentsOverride, rateCard);
    if (amountCents === floor && Math.round(bKm * rate) < floor) {
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
    lineItems.push({ label: `${ride.stops.join(' → ')} (${vehicle})`, amountCents, meta });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents, warnings };
}
