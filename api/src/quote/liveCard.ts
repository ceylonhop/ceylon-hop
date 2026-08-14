import { RATE_CARD, type RateCard } from './rateCard';
import type { ZonesRepo } from '../db/zonesRepo';

// The live rate card composed with the currently-active hot zones (hot-zones spec D5). Built per
// request so a founder zone edit is reflected on the next quote. Zero active zones (or
// HOT_ZONES_DISABLED) => hotZones is [] => pricing identical to pre-hot-zones.
//
// This is the ONLY place a customer-facing or ops price acquires its zone list. The engine does the
// matching and the boost; nothing else composes a card by hand.
export async function liveRateCard(zones: ZonesRepo, base: RateCard = RATE_CARD): Promise<RateCard> {
  return { ...base, hotZones: await zones.activeZones() };
}
