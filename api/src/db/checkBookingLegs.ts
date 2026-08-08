// The pure half of the Phase 1 gate (api/scripts/check-booking-legs.ts). Compares what a booking
// says its route is against what its booking_legs rows say. No database access — reconcileBooking
// takes already-fetched rows and returns human-readable problems; the script's main() is the thin
// I/O half that queries, calls this, and prints.
import type { BookingLegKind } from '../domain/bookingLegs';

export interface LegEndpoints {
  seq: number;
  // The script always selects this (bookingLegs.kind is NOT NULL) — optional here only so a
  // caller that genuinely doesn't care (older tests) doesn't have to supply it. Needed to tell
  // a trip whose rows are all `gap` — no journeys at all — from one with real journeys.
  kind?: BookingLegKind;
  fromPlace: string;
  toPlace: string;
  // A `day` row's intermediate stops (see bookingLegs.ts). Absent/omitted is treated as [] —
  // true for `leg` and `gap` rows, which never have any.
  viaStops?: string[];
  // Absent/omitted is treated as null. Needed to verify the backfill's central claim — that the
  // leg becomes the source of truth for departure time.
  pickupTime?: string | null;
}

export interface RequestData {
  transfer?: { fromPlace: string; toPlace: string; travelTime?: string | null };
  trip?: { stops: string[] };
}

export type ProblemReason =
  | 'shared_has_legs'
  | 'missing_transfer_request'
  | 'leg_count_mismatch'
  | 'endpoint_mismatch'
  | 'stale_pickup_time'
  | 'missing_trip_request'
  | 'no_legs'
  | 'all_gap'
  | 'route_mismatch'
  | 'unknown_mode';

export interface Problem {
  ref: string;
  reason: ProblemReason;
  message: string;
}

function pluralLegs(n: number): string {
  return n === 1 ? 'leg' : 'legs';
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
      return [
        {
          ref,
          reason: 'shared_has_legs',
          message: `shared booking has ${legs.length} ${pluralLegs(legs.length)}, expected 0`,
        },
      ];
    }
    return [];
  }

  if (mode === 'single') {
    const t = data.transfer;
    if (!t) {
      return [{ ref, reason: 'missing_transfer_request', message: 'single booking has no transfer_request' }];
    }
    if (legs.length !== 1) {
      return [{ ref, reason: 'leg_count_mismatch', message: `expected 1 leg, found ${legs.length}` }];
    }
    const [leg] = legs;
    if (leg.fromPlace !== t.fromPlace || leg.toPlace !== t.toPlace) {
      return [
        {
          ref,
          reason: 'endpoint_mismatch',
          message: `leg ${leg.fromPlace}→${leg.toPlace} ≠ transfer ${t.fromPlace}→${t.toPlace}`,
        },
      ];
    }
    // Verifies the backfill's central claim — that the leg becomes the source of truth for
    // departure time. Nothing else checks this: a transfer_request with a recorded travel_time
    // whose leg has no pickup_time means that claim doesn't hold for this booking.
    if (t.travelTime && !leg.pickupTime) {
      return [
        {
          ref,
          reason: 'stale_pickup_time',
          message: `transfer_request.travel_time is ${t.travelTime} but leg pickup_time is null`,
        },
      ];
    }
    return [];
  }

  // A mode that is none of 'shared'/'single'/'trip' (a historical row, or a future mode this
  // script hasn't been taught about yet) used to fall through into the trip branch below and
  // get reported as `missing_trip_request` — true in the narrow sense that there's no
  // trip_request row, but misleading: the actual problem is the mode itself, not a missing trip.
  if (mode !== 'trip') {
    return [{ ref, reason: 'unknown_mode', message: `unrecognised booking mode "${mode}"` }];
  }

  const t = data.trip;
  if (!t) return [{ ref, reason: 'missing_trip_request', message: 'trip booking has no trip_request' }];
  if (!legs.length) {
    return [{ ref, reason: 'no_legs', message: `trip with ${t.stops.length} stops has no legs` }];
  }

  // A `gap` is explicitly never a journey we drive as one (bookingLegs.ts). A trip whose rows
  // are ALL gap has no journeys at all — its customer would never be asked anything — even
  // though its stop chain reconstructs perfectly below. That silent pass is exactly the hole
  // this check exists to close, so it runs before the chain comparison, not instead of it.
  if (legs.every((l) => l.kind === 'gap')) {
    return [
      {
        ref,
        reason: 'all_gap',
        message: `trip has ${legs.length} ${pluralLegs(legs.length)}, all gap — no journeys`,
      },
    ];
  }

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
      reason: 'route_mismatch',
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
