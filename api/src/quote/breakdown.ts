import { billableKm, legPriceCents } from './private';
import { RATE_CARD, type Vehicle } from './rateCard';
import type { QuoteRequest } from './types';

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
export function quoteBreakdown(req: QuoteRequest): QuoteBreakdown {
  const vehicle: Vehicle = 'vehicle' in req ? req.vehicle : 'car';
  const src =
    req.product === 'chauffeur' ? req.travelDays : req.product === 'private' ? req.legs : [];
  const legs: LegBreakdown[] = src.map((l) => {
    const bKm = billableKm(l.distanceKm);
    const raw = Math.round(bKm * RATE_CARD.perKmCents[vehicle]);
    const minApplied = raw < RATE_CARD.floorCents[vehicle];
    return { from: l.from, to: l.to, distanceKm: l.distanceKm, billableKm: bKm, priceCents: legPriceCents(bKm, vehicle), cls: vehicle, minApplied };
  });
  const distanceKm = legs.reduce((s, l) => s + l.distanceKm, 0);
  const billable = legs.reduce((s, l) => s + l.billableKm, 0);
  return { km: { distanceKm, bufferKm: billable - distanceKm, billableKm: billable }, legs };
}
