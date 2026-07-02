import { RATE_CARD } from './rateCard';
import type { SharedLeg, LineItem } from './types';

export function quoteSharedLegs(legs: SharedLeg[]): { lineItems: LineItem[]; subtotalCents: number } {
  const lineItems: LineItem[] = [];
  let subtotalCents = 0;
  for (const leg of legs) {
    const seatTotal = leg.seatPriceCents * leg.seats;
    lineItems.push({ label: `${leg.routeId} × ${leg.seats} seat(s)`, amountCents: seatTotal });
    subtotalCents += seatTotal;
    if (leg.colomboPickup) {
      const surcharge = RATE_CARD.shared.colomboPickupCents * leg.seats;
      lineItems.push({ label: `Colombo city pickup × ${leg.seats}`, amountCents: surcharge });
      subtotalCents += surcharge;
    }
  }
  return { lineItems, subtotalCents };
}
