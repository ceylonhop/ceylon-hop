import type { SingleTransferInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';
import type { MapsAdapter } from '../adapters/maps';
import { quote } from '../quote/engine';
import type { QuoteRequest, ChauffeurTravelDay } from '../quote/types';

// GL-3 — the M11 quote engine is the pricing truth for public bookings (owner decision
// 2026-07-02). Distances come from the maps adapter; anything unresolvable comes back as
// priced:false so the route can fall back + flag, never as a thrown error.
export type PriceOutcome =
  | { currency: 'USD'; totalCents: number; amountDueNowCents: number; priced: true }
  | { priced: false; reason: string };

function unpriced(reason: string): PriceOutcome {
  return { priced: false, reason };
}

// Run the engine, translating any engine rejection (TOO_BIG, NO_LEGS, …) into an
// unpriced outcome — a pricing hiccup must never take the booking flow down.
function runEngine(req: QuoteRequest, isChauffeur: boolean): PriceOutcome {
  try {
    const result = quote(req);
    return {
      currency: 'USD',
      totalCents: result.totalCents,
      // Chauffeur trips pay the deposit now (10%, $50 cap); everything else pays in full.
      amountDueNowCents: isChauffeur ? result.amountDueNowCents : result.totalCents,
      priced: true,
    };
  } catch (err) {
    return unpriced(`engine rejected the request: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export async function priceSingle(input: SingleTransferInput, maps: MapsAdapter): Promise<PriceOutcome> {
  let distance = null;
  try {
    distance = await maps.distance(input.from, input.to);
  } catch {
    distance = null;
  }
  if (!distance) return unpriced(`distance unresolved: ${input.from} → ${input.to}`);
  return runEngine(
    {
      product: 'private',
      vehicle: input.vehicleType === 'van' ? 'van' : 'car',
      pax: input.adults + input.children,
      bags: input.bags,
      legs: [{ from: input.from, to: input.to, distanceKm: distance.km }],
      extras: input.extras,
    },
    false,
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
function chauffeurDates(input: TripInput, legs: { from: string; to: string; distanceKm: number }[]): {
  firstDate: string;
  lastDate: string;
  travelDays: ChauffeurTravelDay[];
} {
  const real = input.dates?.slice(0, legs.length);
  if (real && real.length === legs.length && real.every(isUsableDate)) {
    const sorted = [...real].sort();
    return {
      firstDate: sorted[0],
      lastDate: sorted[sorted.length - 1],
      travelDays: legs.map((leg, i) => ({ date: real[i], ...leg })),
    };
  }
  const days = input.days ?? legs.length;
  const lastDate = addDays(SYNTHETIC_FIRST_DATE, days - 1);
  return {
    firstDate: SYNTHETIC_FIRST_DATE,
    lastDate,
    travelDays: legs.map((leg, i) => ({ date: i < days ? addDays(SYNTHETIC_FIRST_DATE, i) : lastDate, ...leg })),
  };
}

export async function priceTrip(input: TripInput, maps: MapsAdapter): Promise<PriceOutcome> {
  const legs: { from: string; to: string; distanceKm: number }[] = [];
  for (let i = 0; i < input.stops.length - 1; i++) {
    const from = input.stops[i];
    const to = input.stops[i + 1];
    let leg = null;
    try {
      leg = await maps.distance(from, to);
    } catch {
      leg = null;
    }
    if (!leg) return unpriced(`distance unresolved: ${from} → ${to}`);
    legs.push({ from, to, distanceKm: leg.km });
  }

  const vehicle = input.vehicleType === 'van' ? 'van' : 'car';
  if (input.serviceType === 'chauffeur') {
    return runEngine({ product: 'chauffeur', vehicle, ...chauffeurDates(input, legs) }, true);
  }
  // Public trips don't collect a bag count — 0 lets pax alone drive the vehicle floor.
  return runEngine({ product: 'private', vehicle, pax: input.pax, bags: 0, legs }, false);
}

// A shared seat is priced from the corridor's per-seat DB price × the number of seats —
// already server-authoritative, so no engine call and no unpriced arm. (The engine's
// Colombo-pickup surcharge is not in the public payload; don't invent it.)
export function priceShared(seats: number, seatPriceCents: number): Extract<PriceOutcome, { priced: true }> {
  const totalCents = seats * seatPriceCents;
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
    return { currency: 'USD', total: (nights + 1) * CHAUFFEUR_DAY_CENTS };
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
