// The pure half of the Phase 1 gate (api/scripts/check-booking-legs.ts). Compares what a booking
// says its route is against what its booking_legs rows say. No database access — reconcileBooking
// takes already-fetched rows and returns human-readable problems; the script's main() is the thin
// I/O half that queries, calls this, and prints.

export interface LegEndpoints {
  seq: number;
  fromPlace: string;
  toPlace: string;
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

  // A `day` row legitimately spans several stops (one chauffeur travel day), so leg COUNTS are
  // never compared here — only that the chain starts and ends where the trip does.
  const first = legs[0]!;
  const last = legs[legs.length - 1]!;
  if (first.fromPlace !== t.stops[0] || last.toPlace !== t.stops[t.stops.length - 1]) {
    return [
      {
        ref,
        message: `legs run ${first.fromPlace}→${last.toPlace}, trip runs ${t.stops[0]}→${t.stops[t.stops.length - 1]}`,
      },
    ];
  }
  return [];
}
