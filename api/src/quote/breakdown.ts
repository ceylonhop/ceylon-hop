import { billableKm, legPriceCents } from './private';
import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { QuoteRequest } from './types';
import { pricedVehicle } from './vehicle';

export interface LegBreakdown {
  from: string;
  to: string;
  distanceKm: number;
  billableKm: number;
  priceCents: number;
  cls: Vehicle;
  minApplied: boolean;
}
export interface QuoteBreakdown {
  km: { distanceKm: number; bufferKm: number; billableKm: number };
  legs: LegBreakdown[];
}

// UI-facing breakdown computed from the engine's own primitives — the km strip and per-leg
// prices the Summary/timeline show. Deliberately NOT part of the core quote() result (P8).
export function quoteBreakdown(req: QuoteRequest, rateCard: RateCard = RATE_CARD): QuoteBreakdown {
  // Use the tier the engine actually prices with (private requests may be upgraded past
  // req.vehicle for capacity — see vehicle.ts's pricedVehicle / engine.ts's anti-tamper logic).
  const vehicle: Vehicle = pricedVehicle(req, rateCard);
  // GL-1d: mirror the engine's custom per-km rate so the timeline's per-leg prices match the
  // priced total. Only honored on the custom-priced tiers (engine validates; this is defensive).
  const override =
    req.product !== 'shared' && (vehicle === 'van14' || vehicle === 'custom') ? req.customPerKmCents : undefined;
  const perKm = override ?? rateCard.perKmCents[vehicle];
  const src =
    req.product === 'chauffeur' ? req.travelDays : req.product === 'private' ? req.legs : [];
  const legs: LegBreakdown[] = src.map((l) => {
    const bKm = billableKm(l.distanceKm, rateCard);
    const raw = Math.round(bKm * perKm);
    if (req.product === 'chauffeur') {
      // Chauffeur per-leg prices are the km-charge share only (no per-leg floor) — day
      // rate / idle-day minimum km are separate engine line items (see chauffeur.ts).
      return { from: l.from, to: l.to, distanceKm: l.distanceKm, billableKm: bKm, priceCents: raw, cls: vehicle, minApplied: false };
    }
    const minApplied = raw < rateCard.floorCents[vehicle];
    return { from: l.from, to: l.to, distanceKm: l.distanceKm, billableKm: bKm, priceCents: legPriceCents(bKm, vehicle, override, rateCard), cls: vehicle, minApplied };
  });
  const distanceKm = legs.reduce((s, l) => s + l.distanceKm, 0);
  const billable = legs.reduce((s, l) => s + l.billableKm, 0);
  return { km: { distanceKm, bufferKm: billable - distanceKm, billableKm: billable }, legs };
}
