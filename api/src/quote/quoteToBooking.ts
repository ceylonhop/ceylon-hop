import type { SavedQuote } from '../db/quoteRepo';
import type { QuoteRequest, Ride } from './types';
import { normalizeRide, normalizeChauffeurDay, rideRawKm } from './types';
import type { SingleTransferInput, CustomerInput } from '../domain/singleTransfer';
import type { TripInput } from '../domain/trip';

// The booking fields the quote can't supply — collected by the ops "Mark booked" modal.
export interface BookingDetails {
  customer: CustomerInput;
  vehicleType: 'car' | 'van';
  pax: number;
  bags: number;
  date?: string;
  time?: string;
}

export type MappedBooking =
  | { mode: 'single'; input: SingleTransferInput; distanceKm: number | null }
  | { mode: 'trip'; input: TripInput; distanceKm: number | null };

// The quote has no bookable itinerary (shared, or a legacy row with no engine request).
export class QuoteNotBookableError extends Error {}

function sumKm(rides: Ride[]): number | null {
  if (!rides.length) return null;
  const total = rides.reduce((a, r) => a + rideRawKm(r), 0);
  return total > 0 ? Math.round(total) : null;
}

// Chain the rides into one stop list. A later ride that does NOT start where the previous one
// ended still contributes its own origin — that hop is the customer's own arrangement (e.g. the
// Ella → Galle train), not something to silently drop. This replaces the old behaviour, which
// dropped the non-chaining origin and so invented a leg nobody drives (GC-13); it reached the
// ops drawer AND the customer's email. The booking's flat `stops` array can't mark which
// consecutive pair is a gap versus a driven leg — every pair renders as a leg we drive
// downstream (known gap, see docs/known-bugs.md 2026-07-30).
//
// `rideIndex` says which ride each segment belongs to (-1 for a gap). Anything the caller keeps
// aligned per segment (today: `dates`) must be rebuilt through it, because inserting a gap stop
// shifts every later index.
function chainStops(rides: Ride[]): { stops: string[]; rideIndex: number[] } {
  const stops = [...rides[0].stops];
  const rideIndex: number[] = rides[0].stops.slice(1).map(() => 0);
  rides.slice(1).forEach((ride, i) => {
    if (ride.stops[0] !== stops[stops.length - 1]) {
      stops.push(ride.stops[0]); // the gap: a stop we don't drive to/from the previous one
      rideIndex.push(-1);
    }
    for (const stop of ride.stops.slice(1)) {
      stops.push(stop);
      rideIndex.push(i + 1);
    }
  });
  return { stops, rideIndex };
}

// Inclusive day span between two ISO dates (e.g. 08-01..08-03 = 3 days).
function daySpan(firstDate: string, lastDate: string): number {
  const ms = Date.parse(lastDate) - Date.parse(firstDate);
  if (Number.isNaN(ms)) return 1;
  return Math.max(1, Math.round(ms / 86_400_000) + 1);
}

// Partial-leg pay links (spec 2026-08-04). `legIndexes` says which of `engine.legs` this booking
// covers — the legs the customer actually paid for. Absent = the whole itinerary, which is every
// pre-existing caller. Private only; a chauffeur quote never carries a selection.
export interface MapOptions {
  legIndexes?: number[];
}

// Deduped and sorted, so a selection is a SET of legs in itinerary order however ops clicked it.
// Out-of-range indexes are dropped rather than throwing: the caller's own guard (an empty result
// is not bookable) is the one that should speak, and it does so below.
function selectRides<T>(rides: T[], legIndexes?: number[]): T[] {
  if (!legIndexes) return rides;
  return [...new Set(legIndexes)]
    .sort((a, b) => a - b)
    .filter((i) => i >= 0 && i < rides.length)
    .map((i) => rides[i]);
}

// Map a stored ops quote's engine request + the modal details into a bookable input.
// Private single-leg → single; private multi-leg or chauffeur → trip. Shared / engine-less
// quotes throw (ops quotes are private/chauffeur; nothing else reaches this path).
export function quoteToBooking(
  quote: SavedQuote,
  details: BookingDetails,
  opts?: MapOptions,
): MappedBooking {
  const engine = (quote.request as { engine?: QuoteRequest } | null)?.engine;
  if (!engine || engine.product === 'shared') {
    throw new QuoteNotBookableError('quote has no bookable itinerary');
  }

  if (engine.product === 'private') {
    // AFTER the filter, so an empty selection is refused by the same guard that refuses a
    // legless quote — one rule, one error, no second copy to drift.
    const rides = selectRides(engine.legs.map(normalizeRide), opts?.legIndexes);
    if (!rides.length) throw new QuoteNotBookableError('private quote has no legs');
    const distanceKm = sumKm(rides);
    // A single 2-stop ride is a point-to-point transfer (today's behavior); a single 3+-stop
    // ride, or any multi-ride itinerary, is a trip.
    if (rides.length === 1 && rides[0].stops.length === 2) {
      return {
        mode: 'single',
        distanceKm,
        input: {
          from: rides[0].stops[0],
          to: rides[0].stops[1],
          date: details.date,
          time: details.time,
          vehicleType: details.vehicleType,
          adults: details.pax,
          children: 0,
          bags: details.bags,
          customer: details.customer,
        },
      };
    }
    const { stops } = chainStops(rides);
    const startDate = details.date;
    const segmentCount = Math.max(0, stops.length - 1);
    return {
      mode: 'trip',
      distanceKm,
      input: {
        stops,
        nights: Array(segmentCount).fill(0),
        // Per segment, like the chauffeur branch, so the two don't drift. A PrivateLeg carries
        // no date of its own (the operator's per-leg dates live in the quote's TOOL payload,
        // not the engine request we map from — logged as its own bug), so the only date we know
        // is the trip start from the modal: it lands on the first segment and the rest stay
        // blank — exactly what the old single-element array meant.
        dates: startDate ? Array.from({ length: segmentCount }, (_, i) => (i === 0 ? startDate : '')) : undefined,
        pax: details.pax,
        vehicleType: details.vehicleType,
        serviceType: 'private',
        customer: details.customer,
      },
    };
  }

  // chauffeur
  if (!engine.travelDays.length) throw new QuoteNotBookableError('chauffeur quote has no travel days');
  const days = engine.travelDays.map(normalizeChauffeurDay).sort((a, b) => a.date.localeCompare(b.date));
  const span = daySpan(engine.firstDate, engine.lastDate);
  const { stops, rideIndex } = chainStops(days);
  return {
    mode: 'trip',
    distanceKm: sumKm(days),
    input: {
      stops,
      nights: Array(Math.max(0, stops.length - 1)).fill(0),
      // One date per SEGMENT, not per day: a day with 3+ stops owns several segments, and a gap
      // stop shifts every later index. Rebuild it through rideIndex so each date stays on the
      // segment it belongs to; a gap gets '' (blank reads as "flexible" everywhere downstream).
      dates: rideIndex.map((i) => (i < 0 ? '' : days[i].date)),
      pax: details.pax,
      vehicleType: details.vehicleType,
      serviceType: 'chauffeur',
      customer: details.customer,
      days: span,
      driverNights: Math.max(0, span - 1),
    },
  };
}

// Would quoteToBooking accept this quote?
//
// The mint route needs to know BEFORE handing a link to a customer, because the alternative
// is what the owner hit while testing (2026-07-31): a page that renders as fully payable and
// then answers 409 `quote_unavailable` the moment Continue is tapped — a dead end in front of
// a paying customer, with nothing the ops team can see.
//
// Deliberately implemented by running the real mapping against a placeholder booking detail
// rather than re-checking `legs.length` / `travelDays.length` here. A second copy of the rule
// is a second thing to drift; this way "mintable" is defined as "pay-commit would succeed",
// by construction.
const BOOKABILITY_PROBE: BookingDetails = {
  customer: { firstName: 'x', lastName: 'x', email: 'x@x.x', whatsapp: 'x', country: 'x' },
  vehicleType: 'car',
  pax: 1,
  bags: 0,
};

export function isQuoteBookable(quote: SavedQuote, opts?: MapOptions): boolean {
  try {
    quoteToBooking(quote, BOOKABILITY_PROBE, opts);
    return true;
  } catch (e) {
    if (e instanceof QuoteNotBookableError) return false;
    throw e; // a real fault — never silently read as "not bookable"
  }
}
