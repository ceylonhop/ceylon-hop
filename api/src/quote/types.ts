import type { ResolvedDiscount } from './discount';
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

// An extra may arrive as a bare code (website / single-transfer paths, and every stored
// quote predating attribution) or attributed to the driving leg that carries it (ops tool).
// legIndex indexes the engine's DRIVING legs — the same list `quotePrivateLegs` prices —
// never the ops tool's raw `state.legs`, which includes stay days.
export type ExtraInput = ExtraCode | { code: ExtraCode; legIndex?: number };
export interface NormalizedExtra { code: ExtraCode; legIndex?: number }

export function normalizeExtra(e: ExtraInput): NormalizedExtra {
  return typeof e === 'string' ? { code: e } : { code: e.code, legIndex: e.legIndex };
}

// customPerKmCents (GL-1d): van14/custom have no fixed owner rate — the operator sets the
// per-km rate at quote time (rate-card values are prefill defaults only). The engine rejects
// an override when the priced vehicle is any other tier.
// legs/travelDays accept the OLD point-to-point shape AND the new Ride shape interchangeably
// (multi-stop rides, phase 1). Every consumer normalizes via normalizeRide/normalizeChauffeurDay
// at entry, so an old-shape leg and its 2-stop Ride equivalent price identically.
export type QuoteRequest =
  | { product: 'shared'; legs: SharedLeg[] }
  | { product: 'private'; vehicle: Vehicle; pax: number; bags: number; legs: (PrivateLeg | Ride)[]; extras?: ExtraInput[]; customPerKmCents?: number }
  // pax/bags optional: when present, the engine upgrades an undersized vehicle to fit (like
  // private); when absent, no capacity upgrade (back-compat for callers that don't pass them).
  | { product: 'chauffeur'; vehicle: Vehicle; firstDate: string; lastDate: string; travelDays: (ChauffeurTravelDay | ChauffeurRideDay)[]; pax?: number; bags?: number; extras?: ExtraInput[]; customPerKmCents?: number };

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
//
// The consecutive-differ rule (spec §3: "no zero-length A → A segments") is a MULTI-STOP rule
// and applies only to rides with 3+ stops. A normalized old-shape 2-stop leg is EXEMPT: the
// pre-ride-model engine never compared from/to and priced a same-place leg (with a manual
// round-trip km) fine, so rejecting it here would 422 stored quotes on reopen (GC-5 back-compat).
export function validateRide(ride: Ride): void {
  if (ride.stops.length < 2) throw new Error('INVALID_RIDE');
  if (ride.segmentKms.length !== ride.stops.length - 1) throw new Error('INVALID_RIDE');
  if (ride.stops.length >= 3) {
    for (let i = 0; i < ride.stops.length - 1; i++) {
      if (ride.stops[i].trim() === ride.stops[i + 1].trim()) throw new Error('INVALID_RIDE');
    }
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
  // Founder manual discounts (spec 2026-08-09). ABSENT — not zero — when no discount was
  // requested, so an undiscounted QuoteResult stays byte-identical to what it was before the
  // feature existed. That is what the zero-discount gate in goldens.test.ts relies on.
  // `discount` is present whenever a discount was REQUESTED, even if both limits reduced it to
  // zero, so a caller can tell "capped to nothing" from "never asked".
  discountCents?: number;
  totalBeforeDiscountCents?: number;
  discount?: ResolvedDiscount;
  rateCardVersion: string;
  warnings: string[];
}
