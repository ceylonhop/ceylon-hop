import { RATE_CARD, type Vehicle } from './rateCard';
import type { PrivateLeg, LineItem } from './types';

export function billableKm(rawKm: number): number {
  return Math.round(rawKm * (1 + RATE_CARD.bufferPct / 100));
}

// perKmCentsOverride (GL-1d): the operator's custom rate for van14/custom — validated by
// engine.ts before it reaches here; tier floors still apply.
export function legPriceCents(distanceKm: number, vehicle: Vehicle, perKmCentsOverride?: number): number {
  const rate = perKmCentsOverride ?? RATE_CARD.perKmCents[vehicle];
  const perKm = Math.round(distanceKm * rate);
  return Math.max(RATE_CARD.floorCents[vehicle], perKm);
}

export function quotePrivateLegs(
  legs: PrivateLeg[],
  vehicle: Vehicle,
  perKmCentsOverride?: number,
): { lineItems: LineItem[]; subtotalCents: number; warnings: string[] } {
  const lineItems: LineItem[] = [];
  const warnings: string[] = [];
  let subtotalCents = 0;
  const floor = RATE_CARD.floorCents[vehicle];
  const dollars = `$${RATE_CARD.floorCents[vehicle] / 100}`;
  const rate = perKmCentsOverride ?? RATE_CARD.perKmCents[vehicle];

  for (const leg of legs) {
    const bKm = billableKm(leg.distanceKm);
    const amountCents = legPriceCents(bKm, vehicle, perKmCentsOverride);
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
