import { billableKm } from './private';
import { zoneBoostForStops } from './hotZones';
import { RATE_CARD, type RateCard, type Vehicle } from './rateCard';
import type { QuoteRequest, Ride } from './types';
import { normalizeRide, normalizeChauffeurDay, rideRawKm } from './types';
import { pricedVehicle } from './vehicle';

export interface LegBreakdown {
  from: string;
  to: string;
  // Present ONLY for a Ride with ≥3 stops (GC-4); old-shape / 2-stop rows omit it entirely.
  stops?: string[];
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
  // Hot-zone parity: the engines boost a zone-touching ride's per-km rate (private per ride,
  // chauffeur per day) — the breakdown must price with the SAME boost or the itinerary leg
  // chip and the money-pane line show two different prices for one leg. A custom rate is
  // authoritative (D11): zones off, exactly as both engines do. At zero zones boost=1 and
  // every number is byte-identical to the pre-hot-zones path.
  const zones = override != null ? undefined : rateCard.hotZones;
  // Second raw-request consumer (ops /estimate calls this directly): normalize identically to
  // the engine so old-shape and Ride inputs collapse to the same per-ride rows.
  const src: Ride[] =
    req.product === 'chauffeur' ? req.travelDays.map(normalizeChauffeurDay)
      : req.product === 'private' ? req.legs.map(normalizeRide)
      : [];
  const legs: LegBreakdown[] = src.map((ride) => {
    const rawKm = rideRawKm(ride);
    const bKm = billableKm(rawKm, rateCard);
    const raw = Math.round(bKm * perKm * zoneBoostForStops(ride.stops, zones));
    const from = ride.stops[0];
    const to = ride.stops[ride.stops.length - 1];
    // Chauffeur per-leg prices are the km-charge share only (no per-leg floor); private applies
    // the tier floor. from/to are always first/last stop; distanceKm is the segment sum.
    const row: LegBreakdown =
      req.product === 'chauffeur'
        ? { from, to, distanceKm: rawKm, billableKm: bKm, priceCents: raw, cls: vehicle, minApplied: false }
        : { from, to, distanceKm: rawKm, billableKm: bKm, priceCents: Math.max(rateCard.floorCents[vehicle], raw), cls: vehicle, minApplied: raw < rateCard.floorCents[vehicle] };
    if (ride.stops.length >= 3) row.stops = ride.stops; // GC-4: only multi-stop rides carry stops
    return row;
  });
  const distanceKm = legs.reduce((s, l) => s + l.distanceKm, 0);
  const billable = legs.reduce((s, l) => s + l.billableKm, 0);
  return { km: { distanceKm, bufferKm: billable - distanceKm, billableKm: billable }, legs };
}
