// One record per journey in a booking. A journey is currently a POSITION between two entries in
// trip_request.stops[], which means anything attached to it silently follows the position when the
// trip changes — see docs/superpowers/specs/2026-08-08-post-payment-trip-details-design.md §1.
//
// Pure on purpose: the writers and the backfill share this one definition, so a leg derived at
// booking time and a leg derived by the backfill can never disagree.

/**
 * `leg` — a journey between two overnight stops (single transfer, or a private trip's pair).
 * `day` — one chauffeur TRAVEL DAY, which may pass through several stops.
 * `gap`  — a connector chainStops() inserted between two chauffeur days (quoteToBooking.ts:46).
 *          Recorded so the route stays complete; never a journey we drive as one.
 */
export type BookingLegKind = 'leg' | 'day' | 'gap';

export interface DerivedLeg {
  seq: number;
  kind: BookingLegKind;
  fromPlace: string;
  toPlace: string;
  viaStops: string[];
  travelDate: string | null;
  pickupTime: string | null;
}

export function deriveSingleLegs(input: {
  from: string;
  to: string;
  date?: string | null;
  time?: string | null;
}): DerivedLeg[] {
  return [
    {
      seq: 1,
      kind: 'leg',
      fromPlace: input.from,
      toPlace: input.to,
      viaStops: [],
      travelDate: input.date || null,
      pickupTime: input.time || null,
    },
  ];
}

export function deriveTripLegs(input: {
  stops: string[];
  dates?: string[] | null;
  serviceType: 'private' | 'chauffeur';
}): DerivedLeg[] {
  const { stops, serviceType } = input;
  const dates = input.dates ?? [];
  if (stops.length < 2) return [];
  const rows =
    serviceType === 'chauffeur' ? chauffeurDays(stops, dates) : privateLegs(stops, dates);
  return rows.map((row, i) => ({ ...row, seq: i + 1 }));
}

type Unsequenced = Omit<DerivedLeg, 'seq'>;

// For a private trip, a blank date means "flexible", not "gap" — the heuristic chauffeurDays()
// uses (blank = chainStops()'s connector) is NOT available here. chainStops() also inserts a
// connector for a hop the customer makes themselves (the Ella→Galle train case — see
// docs/known-bugs.md, 2026-07-30), and that connector is indistinguishable from a driven leg at
// this layer: it comes through as an ordinary consecutive pair with no marker of its own. So this
// always emits `kind: 'leg'`, even for a connector. A later phase that wants to tell "we drive
// this" apart from "the customer arranges this themselves" needs a signal this function does not
// have — this is a note for whoever designs that phase, not a bug to fix here.
function privateLegs(stops: string[], dates: string[]): Unsequenced[] {
  return stops.slice(0, -1).map((from, i) => ({
    kind: 'leg' as const,
    fromPlace: from,
    toPlace: stops[i + 1],
    viaStops: [],
    travelDate: dates[i] || null,
    pickupTime: null,
  }));
}

// A chauffeur booking stores one date per SEGMENT (quoteToBooking.ts:170), so consecutive segments
// carrying the same non-empty date are the same travel day. A blank date is chainStops()'s gap.
//
// This leans on every chauffeur travel day being dated — a precondition enforced above this
// layer, not in the schema (`TripInput.dates` is optional): the booker refuses to let a customer
// pick chauffeur service until every leg has a date (booking.js:906, tripDatesComplete()), and
// pricing refuses to price an undated chauffeur quote (internalQuote.ts:323-330). Without that
// precondition a trip with genuinely no dates would read as ALL gaps — see the no-dates-at-all
// fallback below, which exists precisely because a fully-undated chauffeur trip must still
// produce askable journeys, not zero of them.
function chauffeurDays(stops: string[], dates: string[]): Unsequenced[] {
  // A blank date is only meaningful as "chainStops() connector" when the trip has dates
  // elsewhere. A chauffeur trip with NO dates at all (e.g. still being drafted, or a producer
  // that hasn't supplied dates yet) is not "all gaps" — every segment is still a journey we will
  // need to ask the customer about, so fall back to one `day` row per segment.
  if (!dates.some((d) => !!d)) {
    return stops.slice(0, -1).map((from, i) => ({
      kind: 'day' as const,
      fromPlace: from,
      toPlace: stops[i + 1],
      viaStops: [],
      travelDate: null,
      pickupTime: null,
    }));
  }
  const out: Unsequenced[] = [];
  const lastSegment = stops.length - 2;
  let i = 0;
  while (i <= lastSegment) {
    const date = dates[i] || '';
    if (!date) {
      out.push({
        kind: 'gap',
        fromPlace: stops[i],
        toPlace: stops[i + 1],
        viaStops: [],
        travelDate: null,
        pickupTime: null,
      });
      i += 1;
      continue;
    }
    let end = i;
    while (end < lastSegment && (dates[end + 1] || '') === date) end += 1;
    out.push({
      kind: 'day',
      fromPlace: stops[i],
      toPlace: stops[end + 1],
      viaStops: stops.slice(i + 1, end + 1),
      travelDate: date,
      pickupTime: null,
    });
    i = end + 1;
  }
  return out;
}
