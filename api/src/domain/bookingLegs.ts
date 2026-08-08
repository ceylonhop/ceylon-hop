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
function chauffeurDays(stops: string[], dates: string[]): Unsequenced[] {
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
