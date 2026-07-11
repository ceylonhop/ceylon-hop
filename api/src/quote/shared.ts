import { RATE_CARD, type RateCard } from './rateCard';
import type { SharedLeg, LineItem } from './types';

export function quoteSharedLegs(legs: SharedLeg[], rateCard: RateCard = RATE_CARD): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const leg of legs) {
    const seatTotal = leg.seatPriceCents * leg.seats;
    lineItems.push({ label: `${leg.routeId} × ${leg.seats} seat(s)`, amountCents: seatTotal });
    subtotalCents += seatTotal;
    if (leg.colomboPickup) {
      const surcharge = rateCard.shared.colomboPickupCents * leg.seats;
      lineItems.push({ label: `Colombo city pickup × ${leg.seats}`, amountCents: surcharge });
      subtotalCents += surcharge;
    }
  }
  return { lineItems, subtotalCents };
}
