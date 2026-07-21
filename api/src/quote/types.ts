import type { Vehicle, ExtraCode } from './rateCard';
import type { PriceFinishStrategy } from './priceFinish';

export interface PrivateLeg { from: string; to: string; distanceKm: number }
export interface SharedLeg { routeId: string; seats: number; seatPriceCents: number; colomboPickup?: boolean }
export interface ChauffeurTravelDay { date: string; from: string; to: string; distanceKm: number }

// Ride: one day's journey as an ordered list of 2+ stops (multi-stop rides model, phase 1).
// The old {from,to,distanceKm} point-to-point shape normalizes to a 2-stop Ride via
// normalizeRide/normalizeChauffeurDay below.
export interface Ride { stops: string[]; segmentKms: number[] }
export interface ChauffeurRideDay extends Ride { date: string }

// customPerKmCents (GL-1d): van14/custom have no fixed owner rate — the operator sets the
// per-km rate at quote time (rate-card values are prefill defaults only). The engine rejects
// an override when the priced vehicle is any other tier.
// legs/travelDays accept the OLD point-to-point shape AND the new Ride shape interchangeably
// (multi-stop rides, phase 1). Every consumer normalizes via normalizeRide/normalizeChauffeurDay
// at entry, so an old-shape leg and its 2-stop Ride equivalent price identically.
export type QuoteRequest =
  | { product: 'shared'; legs: SharedLeg[] }
  | { product: 'private'; vehicle: Vehicle; pax: number; bags: number; legs: (PrivateLeg | Ride)[]; extras?: ExtraCode[]; customPerKmCents?: number }
  // pax/bags optional: when present, the engine upgrades an undersized vehicle to fit (like
  // private); when absent, no capacity upgrade (back-compat for callers that don't pass them).
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: (ChauffeurTravelDay | ChauffeurRideDay)[]; pax?: number; bags?: number; extras?: ExtraCode[]; customPerKmCents?: number };

// normalizeRide / normalizeChauffeurDay: discriminate old vs. new shape via 'stops' in leg,
// so a Ride/ChauffeurRideDay passes through unchanged (same array references — no copy drift).
export function normalizeRide(leg: PrivateLeg | Ride): Ride {
  if ('stops' in leg) return leg;
  return { stops: [leg.from, leg.to], segmentKms: [leg.distanceKm] };
}

export function normalizeChauffeurDay(day: ChauffeurTravelDay | ChauffeurRideDay): ChauffeurRideDay {
  if ('stops' in day) return day;
  return { date: day.date, stops: [day.from, day.to], segmentKms: [day.distanceKm] };
}

export function rideRawKm(ride: Ride): number {
  return ride.segmentKms.reduce((sum, km) => sum + km, 0);
}

// validateRide: engine-level shape/consistency checks only. The 8-stop cap is an ops-schema
// rule, not enforced here — the engine accepts any length >= 2. Out-and-back (['A','B','A'])
// is accepted: only CONSECUTIVE stop pairs equal after trim are rejected.
export function validateRide(ride: Ride): void {
  if (ride.stops.length < 2) throw new Error('INVALID_RIDE');
  if (ride.segmentKms.length !== ride.stops.length - 1) throw new Error('INVALID_RIDE');
  for (let i = 0; i < ride.stops.length - 1; i++) {
    if (ride.stops[i].trim() === ride.stops[i + 1].trim()) throw new Error('INVALID_RIDE');
  }
  for (const km of ride.segmentKms) {
    if (!Number.isFinite(km) || km < 0) throw new Error('INVALID_RIDE');
  }
}

export interface LineItem { label: string; amountCents: number; meta?: Record<string, unknown> }

export interface QuoteResult {
  product: 'shared' | 'private' | 'chauffeur';
  currency: 'USD';
  lineItems: LineItem[];
  subtotalCents: number;
  totalCents: number;
  priceAdjustmentCents: number;
  priceStrategy: PriceFinishStrategy;
  depositCents: number;
  amountDueNowCents: number;
  marginEstimateCents: number | null; // total − cost basis; null for shared (cost not modelled). FOUNDER-ONLY (margin:view): stripped server-side (incl. nested in a persisted quote's `result`) for finance/ops — see internalQuote.ts stripQuoteMargin()
  rateCardVersion: string;
  warnings: string[];
}
