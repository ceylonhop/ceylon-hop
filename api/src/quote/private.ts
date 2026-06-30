import { RATE_CARD, type Vehicle } from './rateCard';
import type { PrivateLeg, LineItem } from './types';

export function billableKm(rawKm: number): number {
  return Math.round(rawKm * (1 + RATE_CARD.bufferPct / 100));
}

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
    const bKm = billableKm(leg.distanceKm);
    const amountCents = legPriceCents(bKm, vehicle);
    if (amountCents === floor && Math.round(bKm * RATE_CARD.perKmCents[vehicle]) < floor) {
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
