// The pure half of the Phase 1 gate (api/scripts/check-booking-legs.ts). Compares what a booking
// says its route is against what its booking_legs rows say. No database access — reconcileBooking
// takes already-fetched rows and returns human-readable problems; the script's main() is the thin
// I/O half that queries, calls this, and prints.

export interface LegEndpoints {
  seq: number;
  fromPlace: string;
  toPlace: string;
  // A `day` row's intermediate stops (see bookingLegs.ts). Absent/omitted is treated as [] —
  // true for `leg` and `gap` rows, which never have any.
  viaStops?: string[];
}

export interface RequestData {
  transfer?: { fromPlace: string; toPlace: string };
  trip?: { stops: string[] };
}

export interface Problem {
  ref: string;
  message: string;
}

/**
 * Compares one booking's declared route (from its transfer_request / trip_request) against its
 * booking_legs rows and returns the problems found — empty when everything agrees. `legs` must
 * already be ordered by seq.
 */
export function reconcileBooking(
  booking: { ref: string; mode: string },
  data: RequestData,
  legs: LegEndpoints[],
): Problem[] {
  const { ref, mode } = booking;

  if (mode === 'shared') {
    if (legs.length) {
      return [{ ref, message: `shared booking has ${legs.length} legs, expected 0` }];
    }
    return [];
  }

  if (mode === 'single') {
    const t = data.transfer;
    if (!t) return [{ ref, message: 'single booking has no transfer_request' }];
    if (legs.length !== 1) return [{ ref, message: `expected 1 leg, found ${legs.length}` }];
    const [leg] = legs;
    if (leg.fromPlace !== t.fromPlace || leg.toPlace !== t.toPlace) {
      return [
        { ref, message: `leg ${leg.fromPlace}→${leg.toPlace} ≠ transfer ${t.fromPlace}→${t.toPlace}` },
      ];
    }
    return [];
  }

  // trip (and anything that is neither 'shared' nor 'single' — mirrors the brief's fall-through).
  const t = data.trip;
  if (!t) return [{ ref, message: 'trip booking has no trip_request' }];
  if (!legs.length) return [{ ref, message: `trip with ${t.stops.length} stops has no legs` }];

  // Rebuild the full stop sequence the legs imply and compare it to trip_request.stops[]
  // element-for-element. Checking only the endpoints (as this used to) passes a booking whose
  // MIDDLE legs are missing, duplicated, or route through the wrong stop — the review that
  // demanded this rewrite found exactly that hole. A `day` row legitimately spans several stops
  // via viaStops (one chauffeur travel day), which is why leg COUNTS are still never compared —
  // only the resulting stop chain.
  const implied = reconstructStops(legs);
  if (arraysEqual(implied, t.stops)) return [];

  const at = firstDivergence(implied, t.stops);
  return [
    {
      ref,
      message:
        `legs imply ${windowAround(implied, at)} (${implied.length} stops), ` +
        `trip stops are ${windowAround(t.stops, at)} (${t.stops.length} stops) — diverge at stop ${at + 1}`,
    },
  ];
}

// legs[0].fromPlace, then each leg's viaStops (in order) followed by its toPlace. Holds for every
// kind bookingLegs.ts derives: `leg`/`gap` rows have no viaStops so contribute just their toPlace;
// a `day` row's viaStops are exactly the stops it passes through before its toPlace. Chaining them
// in leg order reconstructs trip_request.stops[] exactly when the legs are intact and in order.
function reconstructStops(legs: LegEndpoints[]): string[] {
  const stops = [legs[0]!.fromPlace];
  for (const leg of legs) stops.push(...(leg.viaStops ?? []), leg.toPlace);
  return stops;
}

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

// Index of the first place the two sequences disagree (including one running out before the
// other). Assumes the caller already knows they're not equal.
function firstDivergence(a: string[], b: string[]): number {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if (a[i] !== b[i]) return i;
  }
  return len;
}

// A short excerpt of `stops` centred on `index`, so a long itinerary's problem message still
// shows the operator where the two sequences actually diverge instead of drowning it in stops
// far from the mismatch.
function windowAround(stops: string[], index: number, radius = 2): string {
  const start = Math.max(0, index - radius);
  const end = Math.min(stops.length, index + radius + 1);
  const prefix = start > 0 ? '…' : '';
  const suffix = end < stops.length ? '…' : '';
  return prefix + stops.slice(start, end).join('→') + suffix;
}
