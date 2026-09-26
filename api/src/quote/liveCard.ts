import { RATE_CARD, type RateCard } from './rateCard';
import type { ZonesRepo } from '../db/zonesRepo';
import type { RateRevisionRepo } from '../db/rateRevisionRepo';
import { applyRates } from './rateRevision';

// The code card with the founder's newest saved revision applied (spec 2026-09-26 §8.2), without
// hot zones. No revision saved ⇒ exactly RATE_CARD. The ride board prices seats off this directly:
// shared rides never carry a zone boost (hot-zones spec D8).
export async function currentRateCard(revisions: RateRevisionRepo): Promise<RateCard> {
  const latest = await revisions.latest();
  return latest ? applyRates(RATE_CARD, latest.rates, latest.version) : RATE_CARD;
}

// The live rate card: the current card composed with the currently-active hot zones (hot-zones
// spec D5). Built per request so a founder rate or zone edit is reflected on the next quote. No
// revision and zero active zones (or HOT_ZONES_DISABLED) ⇒ pricing identical to RATE_CARD.
//
// This is the ONLY place a customer-facing or ops price acquires its rates and zone list. The
// engine does the matching and the boost; nothing else composes a card by hand.
export async function liveRateCard(zones: ZonesRepo, revisions: RateRevisionRepo): Promise<RateCard> {
  const [card, hotZones] = await Promise.all([currentRateCard(revisions), zones.activeZones()]);
  return { ...card, hotZones };
}
