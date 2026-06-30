import { RATE_CARD, type Vehicle } from './rateCard';
import type { PrivateLeg, LineItem } from './types';

export function legPriceCents(distanceKm: number, vehicle: Vehicle): number {
  const perKm = Math.round(distanceKm * RATE_CARD.perKmCents[vehicle]);
  return Math.max(RATE_CARD.floorCents[vehicle], perKm);
}

export function quotePrivateLegs(
  legs: PrivateLeg[],
  vehicle: Vehicle,
): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] } {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  const floor = RATE_CARD.floorCents[vehicle];
  const dollars = vehicle === 'car' ? '$29' : '$50';

  for (const leg of legs) {
    const amountCents = legPriceCents(leg.distanceKm, vehicle);
    if (amountCents === floor && Math.round(leg.distanceKm * RATE_CARD.perKmCents[vehicle]) < floor) {
      warnings.push(`${leg.from}→${leg.to} hit the ${dollars} ${vehicle} minimum`);
    }
    lineItems.push({
      label: `${leg.from} → ${leg.to} (${vehicle})`,
      amountCents,
      meta: { distanceKm: leg.distanceKm, vehicle },
    });
    subtotalCents += amountCents;
  }
  return { lineItems, subtotalCents, warnings };
}
