import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { MapsAdapter } from '../adapters/maps';
import { quote } from '../quote/engine';
import { measureLeg } from '../quote/routeChoice';
import { RATE_CARD, type RateCard } from '../quote/rateCard';
import type { QuoteRequest, QuoteResult, ChauffeurRideDay, LineItem, Ride } from '../quote/types';
import { SHARED_EXTRA_LABELS, type SHARED_EXTRA_CODES } from '../domain/shared';

type SharedExtraCode = typeof SHARED_EXTRA_CODES[number];
import type { DiscountRequest } from '../quote/discount';

// The rides a trip's wires form. A wire in `through` continues the current ride onto the next
// wire; a gap wire belongs to no ride. Each ride remembers its wires so dates and road choices
// can be read per wire.
function tripRides(input: TripInput): { wires: number[] }[] {
  const gaps = new Set(input.gaps ?? []);
  const through = new Set(input.through ?? []);
  const rides: { wires: number[] }[] = [];
  let cur: { wires: number[] } | null = null;
  for (let i = 0; i < input.stops.length - 1; i++) {
    if (gaps.has(i)) { cur = null; continue; }
    if (!cur) { cur = { wires: [] }; rides.push(cur); }
    cur.wires.push(i);
    if (!through.has(i)) cur = null;
  }
  return rides;
}

// GL-3 — the M11 quote engine is the pricing truth for public bookings (owner decision
// 2026-07-02). Distances come from the maps adapter; anything unresolvable comes back as
// priced:false so the route can fall back + flag, never as a thrown error.
export type PriceOutcome =
  | {
      currency: 'USD';
      totalCents: number;
      amountDueNowCents: number;
      priced: true;
      /** Present only when a discount was requested (spec 2026-09-14 §7). 0 = limits removed it all. */
      discountCents?: number;
      totalBeforeDiscountCents?: number;
      /** What the engine priced — its request and full result — for a booking to keep. Absent when
       *  no engine ran (shared seats). Server-side only: the result carries the margin. */
      breakdown?: { engine: QuoteRequest; result: QuoteResult };
    }
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

// Customer route choice (spec 2026-09-26-customer-route-choice-design.md §4.2): a booking NEVER
// silently switches road — the customer saw (and was quoted) the local-road price, so a fork
// that can't be confirmed at booking time refuses to charge rather than billing the expressway.
export const ROUTE_CHOICE_UNAVAILABLE = 'route_choice_unavailable';

// Run the engine, translating a genuine pricing hiccup into an unpriced outcome — that must
// never take the booking flow down. A malformed request, by contrast, is rejected outright.
function runEngine(req: QuoteRequest, rateCard: RateCard = RATE_CARD, discount?: DiscountRequest): PriceOutcome {
  try {
    const result = quote(req, rateCard, discount);
    return {
      currency: 'USD',
      totalCents: result.totalCents,
      amountDueNowCents: result.totalCents,
      priced: true,
      breakdown: { engine: req, result },
      ...(discount
        ? {
            discountCents: result.discountCents ?? 0,
            totalBeforeDiscountCents: result.totalBeforeDiscountCents ?? result.totalCents,
          }
        : {}),
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (INVALID_REQUEST_ERRORS.has(msg)) throw new InvalidPricingRequestError(msg);
    return unpriced(`engine rejected the request: ${msg}`);
  }
}

export async function priceSingle(
  input: SingleTransferInput,
  maps: MapsAdapter,
  rateCard: RateCard = RATE_CARD,
  discount?: DiscountRequest,
): Promise<PriceOutcome> {
  let distance = null;
  try {
    distance = await measureLeg(maps, input.from, input.to, input.routeVariant);
  } catch {
    distance = null;
  }
  if (!distance) return unpriced(`distance unresolved: ${input.from} → ${input.to}`);
  // A crow-flies fallback is not a road distance; pricing on it silently mis-charges by tens of
  // percent. Refuse, and let ops price it by hand.
  if (distance.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${input.from} → ${input.to}`);
  // A booking NEVER silently switches road (spec §4.2): the customer saw the local-road price.
  if (input.routeVariant === 'no_tolls' && distance.variant !== 'no_tolls') {
    throw new InvalidPricingRequestError(ROUTE_CHOICE_UNAVAILABLE);
  }
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
    discount,
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
function chauffeurDates(input: TripInput, legs: { wire: number; ride: Ride }[]): {
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurRideDay[];
} {
  const real = legs.map((l) => input.dates?.[l.wire]);
  if (real.every((d) => d && isUsableDate(d))) {
    const sorted = [...(real as string[])].sort();
    return {
      firstDate: sorted[0],
      lastDate: sorted[sorted.length - 1],
      travelDays: legs.map((l, i) => ({ date: real[i] as string, ...l.ride })),
    };
  }
  const days = input.days ?? legs.length;
  const lastDate = addDays(SYNTHETIC_FIRST_DATE, days - 1);
  return {
    firstDate: SYNTHETIC_FIRST_DATE,
    lastDate,
    travelDays: legs.map((l, i) => ({ date: i < days ? addDays(SYNTHETIC_FIRST_DATE, i) : lastDate, ...l.ride })),
  };
}

export async function priceTrip(
  input: TripInput,
  maps: MapsAdapter,
  rateCard: RateCard = RATE_CARD,
  discount?: DiscountRequest,
): Promise<PriceOutcome> {
  const legs: { wire: number; ride: Ride }[] = [];
  for (const r of tripRides(input)) {
    const stops = [input.stops[r.wires[0]], ...r.wires.map((w) => input.stops[w + 1])];
    const segmentKms: number[] = [];
    for (const i of r.wires) {
      const from = input.stops[i];
      const to = input.stops[i + 1];
      let leg = null;
      try {
        leg = await measureLeg(maps, from, to, input.routeVariants?.[i]);
      } catch {
        leg = null;
      }
      if (!leg) return unpriced(`distance unresolved: ${from} → ${to}`);
      if (leg.estimated) return unpriced(`${ESTIMATED_DISTANCE}: ${from} → ${to}`);
      // A booking NEVER silently switches road (spec §4.2): the customer saw the local-road price.
      if (input.routeVariants?.[i] === 'no_tolls' && leg.variant !== 'no_tolls') {
        throw new InvalidPricingRequestError(ROUTE_CHOICE_UNAVAILABLE);
      }
      segmentKms.push(leg.km);
    }
    legs.push({ wire: r.wires[0], ride: { stops, segmentKms } });
  }

  const vehicle = input.vehicleType === 'van' ? 'van' : 'car';
  if (input.serviceType === 'chauffeur') {
    // Public trips don't collect a bag count — pax alone drives the capacity upgrade.
    return runEngine({ product: 'chauffeur', vehicle, pax: input.pax, bags: 0, ...chauffeurDates(input, legs) }, rateCard, discount);
  }
  // Public trips don't collect a bag count — 0 lets pax alone drive the vehicle floor.
  // Every ride is the Ride shape now; a 2-stop Ride prices identically to the old {from,to,distanceKm}
  // (types.ts normalizeRide), pinned at 8900 by the pairwise test in pricing.test.ts.
  return runEngine({ product: 'private', vehicle, pax: input.pax, bags: 0, legs: legs.map((l) => l.ride) }, rateCard, discount);
}

// A shared seat is priced from the corridor's per-seat DB price × the number of seats —
// already server-authoritative, so no engine call and no unpriced arm.
export function priceShared(
  seats: number,
  seatPriceCents: number,
  bags = 0,
  extras: readonly SharedExtraCode[] = [],
  rateCard: RateCard = RATE_CARD,
): Extract<PriceOutcome, { priced: true }> & { lineItems: LineItem[] } {
  // One free bag per seat; each extra bag is the rate card's shared extra-bag fee. This
  // mirrors the front-end quote so what the customer is shown is what actually gets charged.
  const extraBags = Math.max(0, bags - seats);
  const lineItems: LineItem[] = [{ label: `Seats × ${seats}`, amountCents: seats * seatPriceCents }];
  if (extraBags > 0) lineItems.push({ label: `Extra bags × ${extraBags}`, amountCents: extraBags * rateCard.shared.extraBagCents });
  // Add-ons are once per booking, priced from the extras table like a private transfer's, and
  // tagged as the engine tags them so the booking's snapshot names them (snapshotAddOns).
  for (const code of new Set(extras)) {
    const amountCents = rateCard.extras[code];
    // Money path: a card without the price must refuse, never charge NaN or $0.
    if (typeof amountCents !== 'number') throw new Error(`rate card has no price for shared extra ${code}`);
    lineItems.push({ label: SHARED_EXTRA_LABELS[code], amountCents, meta: { kind: 'extra', code } });
  }
  const totalCents = lineItems.reduce((t, l) => t + l.amountCents, 0);
  return { currency: 'USD', totalCents, amountDueNowCents: totalCents, priced: true, lineItems };
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
  const legs = Math.max(0, input.stops.length - 1 - (input.gaps?.length ?? 0));
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
