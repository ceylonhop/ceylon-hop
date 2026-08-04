import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { MapsAdapter } from '../adapters/maps';
import { quote } from '../quote/engine';
import { RATE_CARD, type RateCard } from '../quote/rateCard';
import type { QuoteRequest, ChauffeurRideDay } from '../quote/types';

// GL-3 — the M11 quote engine is the pricing truth for public bookings (owner decision
// 2026-07-02). Distances come from the maps adapter; anything unresolvable comes back as
// priced:false so the route can fall back + flag, never as a thrown error.
export type PriceOutcome =
  | { currency: 'USD'; totalCents: number; amountDueNowCents: number; priced: true }
  | { priced: false; reason: string };

// Distinguishes "we could not resolve this route at all" from "Google was unavailable and we
// refused to price off a crow-flies estimate", so ops isn't sent hunting for a bad place name.
export const ESTIMATED_DISTANCE = 'road distance unavailable';

function unpriced(reason: string): PriceOutcome {
  return { priced: false, reason };
}

// The engine rejects an INVALID REQUEST with one of these. They are not pricing hiccups, so
// they must not fall through to the placeholder: `bags: 100` used to make a $125 transfer a
// chargeable $40 booking. /quote already 422s on exactly this set.
const INVALID_REQUEST_ERRORS = new Set(['TOO_BIG', 'UNKNOWN_EXTRA', 'NO_LEGS']);

export class InvalidPricingRequestError extends Error {
  constructor(public readonly code: string) {
    super(code);
    this.name = 'InvalidPricingRequestError';
  }
}

// Run the engine, translating a genuine pricing hiccup into an unpriced outcome — that must
// never take the booking flow down. A malformed request, by contrast, is rejected outright.
function runEngine(req: QuoteRequest, rateCard: RateCard = RATE_CARD): PriceOutcome {
  try {
    const result = quote(req, rateCard);
    return {
      currency: 'USD',
      totalCents: result.totalCents,
      amountDueNowCents: result.totalCents,
      priced: true,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (INVALID_REQUEST_ERRORS.has(msg)) throw new InvalidPricingRequestError(msg);
    return unpriced(`engine rejected the request: ${msg}`);
  }
}

export async function priceSingle(input: SingleTransferInput, maps: MapsAdapter, rateCard: RateCard = RATE_CARD): Promise<PriceOutcome> {
  let distance = null;
  try {
    distance = await maps.distance(input.from, input.to);
  } catch {
    distance = null;
  }
  if (!distance) return unpriced(`distance unresolved: ${input.from} → ${input.to}`);
  // A crow-flies fallback is not a road distance; pricing on it silently mis-charges by tens of
  // percent. Refuse, and let ops price it by hand.
  if (distance.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${input.from} → ${input.to}`);
  return runEngine(
    {
      product: 'private',
      vehicle: input.vehicleType === 'van' ? 'van' : 'car',
      pax: input.adults + input.children,
      bags: input.bags,
      legs: [{ from: input.from, to: input.to, distanceKm: distance.km }],
      extras: input.extras,
    },
    rateCard,
  );
}

// A usable leg date is a plain YYYY-MM-DD (the engine parses exactly that prefix).
const isUsableDate = (d: string | undefined): d is string => !!d && /^\d{4}-\d{2}-\d{2}$/.test(d);

const DAY_MS = 86_400_000;
const SYNTHETIC_FIRST_DATE = '2000-01-01';

function addDays(ymd: string, days: number): string {
  return new Date(Date.parse(`${ymd}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

// The engine only uses chauffeur dates for the day-span + idle-day count, so when the
// customer left the trip flexible we synthesize a span: `days` long (default one day per
// leg), legs on consecutive days, extra legs sharing the last day.
function chauffeurDates(input: TripInput, legs: PricedRide[]): {
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurRideDay[];
} {
  // `dates` is indexed by the STOP CHAIN (dates[i] = the day you depart stops[i]), so a ride
  // takes the date of the stop it sets off from. For the flat chain startIndex === i and this
  // is the old `dates[i]` exactly; for a grouped ride the hops it passes through mid-day
  // simply don't contribute a date of their own.
  const ride = (leg: PricedRide) => ({ stops: leg.stops, segmentKms: leg.segmentKms });
  const real = legs.map((leg) => input.dates?.[leg.startIndex]);
  if (real.every(isUsableDate)) {
    const dates = real as string[];
    const sorted = [...dates].sort();
    return {
      firstDate: sorted[0],
      lastDate: sorted[sorted.length - 1],
      travelDays: legs.map((leg, i) => ({ date: dates[i], ...ride(leg) })),
    };
  }
  const days = input.days ?? legs.length;
  const lastDate = addDays(SYNTHETIC_FIRST_DATE, days - 1);
  return {
    firstDate: SYNTHETIC_FIRST_DATE,
    lastDate,
    travelDays: legs.map((leg, i) => ({ date: i < days ? addDays(SYNTHETIC_FIRST_DATE, i) : lastDate, ...ride(leg) })),
  };
}

/**
 * The trip as a list of rides, in the order they are travelled.
 *
 * Without `legs` that is one ride per consecutive stop pair — the flat chain, unchanged.
 * With `legs` it is the operator-style grouping: a ride may span several hops and is priced
 * once (one buffer, one floor), which is the whole reason the field exists.
 *
 * `startIndex` is where the ride begins in the stop chain, so a chauffeur travel day can find
 * its date without `dates` having to be re-indexed per leg.
 */
type TripRide = { stops: string[]; startIndex: number };
// A ride with its segment distances resolved, ready for the engine.
type PricedRide = { stops: string[]; segmentKms: number[]; startIndex: number };

function tripRides(input: TripInput): TripRide[] {
  if (input.legs) {
    const rides: TripRide[] = [];
    let at = 0;
    for (const leg of input.legs) {
      rides.push({ stops: leg.stops, startIndex: at });
      at += leg.stops.length - 1; // consecutive rides share an endpoint
    }
    return rides;
  }
  return input.stops.slice(0, -1).map((_, i) => ({ stops: [input.stops[i], input.stops[i + 1]], startIndex: i }));
}

export async function priceTrip(input: TripInput, maps: MapsAdapter, rateCard: RateCard = RATE_CARD): Promise<PriceOutcome> {
  const legs: PricedRide[] = [];
  for (const ride of tripRides(input)) {
    const segmentKms: number[] = [];
    for (let s = 0; s < ride.stops.length - 1; s++) {
      const from = ride.stops[s];
      const to = ride.stops[s + 1];
      let seg = null;
      try {
        seg = await maps.distance(from, to);
      } catch {
        seg = null;
      }
      if (!seg) return unpriced(`distance unresolved: ${from} → ${to}`);
      if (seg.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${from} → ${to}`);
      segmentKms.push(seg.km);
    }
    legs.push({ stops: ride.stops, segmentKms, startIndex: ride.startIndex });
  }

  const vehicle = input.vehicleType === 'van' ? 'van' : 'car';
  if (input.serviceType === 'chauffeur') {
    // Public trips don't collect a bag count — pax alone drives the capacity upgrade.
    return runEngine({ product: 'chauffeur', vehicle, pax: input.pax, bags: 0, ...chauffeurDates(input, legs) }, rateCard);
  }
  // Public trips don't collect a bag count — 0 lets pax alone drive the vehicle floor.
  return runEngine(
    { product: 'private', vehicle, pax: input.pax, bags: 0, legs: legs.map(({ stops, segmentKms }) => ({ stops, segmentKms })) },
    rateCard,
  );
}

// A shared seat is priced from the corridor's per-seat DB price × the number of seats —
// already server-authoritative, so no engine call and no unpriced arm. (The engine's
// Colombo-pickup surcharge is not in the public payload; don't invent it.)
export function priceShared(seats: number, seatPriceCents: number, bags = 0, rateCard: RateCard = RATE_CARD): Extract<PriceOutcome, { priced: true }> {
  // One free bag per seat; each extra bag is the rate card's shared extra-bag fee. This
  // mirrors the front-end quote so what the customer is shown is what actually gets charged.
  const extraBags = Math.max(0, bags - seats);
  const totalCents = seats * seatPriceCents + extraBags * rateCard.shared.extraBagCents;
  return { currency: 'USD', totalCents, amountDueNowCents: totalCents, priced: true };
}

// ── Pre-engine placeholders (kept as the last-resort fallback) ──────────────
// Deterministic stubs from the original end-to-end build. Bookings only land here when
// the engine can't price (unresolvable distance) AND the client sent no quotedTotal —
// i.e. API-only callers; the price is flagged for ops to verify.
const BASE_CENTS = 4000;
const PER_EXTRA_ADULT_CENTS = 1000;
const VAN_SURCHARGE_CENTS = 2000;
const LEG_BASE_CENTS = 5000;
const LEG_VAN_SURCHARGE_CENTS = 1000;
const CHAUFFEUR_DAY_CENTS = 5500;

export function quoteSingleTransfer(input: SingleTransferInput): {
  currency: string;
  total: number;
} {
  const extraAdults = Math.max(0, input.adults - 1);
  let total = BASE_CENTS + extraAdults * PER_EXTRA_ADULT_CENTS;
  if (input.vehicleType === 'van') total += VAN_SURCHARGE_CENTS;
  return { currency: 'USD', total };
}

export function quoteTrip(input: TripInput): { currency: string; total: number } {
  // Chauffeur is billed per day (nights + 1); private is billed per inter-city leg.
  if (input.serviceType === 'chauffeur') {
    const nights = input.nights.reduce((a, b) => a + b, 0);
    // This is a FLOOR under an unpriced booking, so it must not collapse when the client
    // sends a short/empty `nights`: `nights: []` pinned a 9-day trip's floor at one day.
    // A chauffeur trip cannot run in fewer days than it has legs.
    const legs = Math.max(1, input.stops.length - 1);
    const days = Math.max(nights + 1, legs);
    return { currency: 'USD', total: days * CHAUFFEUR_DAY_CENTS };
  }
  const legs = Math.max(0, input.stops.length - 1);
  const perLeg = LEG_BASE_CENTS + (input.vehicleType === 'van' ? LEG_VAN_SURCHARGE_CENTS : 0);
  return { currency: 'USD', total: legs * perLeg };
}

// A shared seat is priced from the corridor's per-seat price × the number of seats.
export function quoteShared(seats: number, seatPriceCents: number): {
  currency: string;
  total: number;
} {
  return { currency: 'USD', total: seats * seatPriceCents };
}
