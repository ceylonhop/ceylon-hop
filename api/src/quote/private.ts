import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { PrivateLeg, LineItem } from './types';

export function billableKm(rawKm: number, rateCard: RateCard = RATE_CARD): number {
  return Math.round(rawKm * (1 + rateCard.bufferPct / 100));
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
  legs: PrivateLeg[],
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

  for (const leg of legs) {
    const bKm = billableKm(leg.distanceKm, rateCard);
    const amountCents = legPriceCents(bKm, vehicle, perKmCentsOverride, rateCard);
    if (amountCents === floor && Math.round(bKm * rate) < floor) {
      warnings.push(`${leg.from}→${leg.to} hit the ${dollars} ${vehicle} minimum`);
    }
    lineItems.push({
      label: `${leg.from} → ${leg.to} (${vehicle})`,
      amountCents,
      meta: { distanceKm: leg.distanceKm, billableKm: bKm, vehicle },
    });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents, warnings };
}
