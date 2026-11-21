// Per-leg ops steps (spec 2026-11-19). A private multi-stop trip is worked one leg at a time: each
// driven leg has its own fulfilment status and ticks (ride_ops_legs), and the booking is finished
// only when its last leg is. Everything else — a single transfer, a shared seat, a chauffeur trip
// (one car and driver for the whole journey), and an older trip with no stored legs — keeps the
// booking-level status on ride_ops.
import type { Booking } from '../db/bookingRepo';
import type { StoredLeg } from '../db/addOnRepo';
import type { RideOpsLeg } from '../db/rideOpsLegRepo';
import type { RideStatus } from '../domain/rideStatus';
import type { LegRideStatus } from '../domain/tripLegStage';
import { isChauffeurBooking } from '../quote/quoteAlternative';

/** One driven leg as the ops tool sees it: the stored leg plus where ops have got to with it. */
export interface LegOpsView {
  legId: string;
  seq: number;
  from: string;
  to: string;
  date: string | null;
  stage: LegRideStatus;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  vehicleConfirmedAt: string | null;
}

/** Whether this booking is worked leg by leg. Stored legs still decide: with none, it is not. */
export function isPerLegTrip(b: Pick<Booking, 'mode' | 'input'>): boolean {
  return b.mode === 'trip' && !isChauffeurBooking(b);
}

/** The legs we drive, in travel order. A gap is the customer's own travel: never an ops job. */
export function drivenLegs(legs: readonly StoredLeg[]): StoredLeg[] {
  return legs.filter((l) => l.kind === 'leg');
}

/** Each driven leg with its ops row; a leg nobody has touched is 'paid'. Empty unless per-leg. */
export function legOpsViews(
  b: Pick<Booking, 'mode' | 'input'>,
  legs: readonly StoredLeg[],
  rows: readonly RideOpsLeg[],
): LegOpsView[] {
  if (!isPerLegTrip(b)) return [];
  const byId = new Map(rows.map((r) => [r.legId, r]));
  return drivenLegs(legs).map((leg) => {
    const r = byId.get(leg.id);
    return {
      legId: leg.id, seq: leg.seq, from: leg.from, to: leg.to, date: leg.travelDate,
      stage: r?.fulfilmentStatus ?? 'paid',
      vehiclePhotoReceived: r?.vehiclePhotoReceived ?? false,
      customerUpdated: r?.customerUpdated ?? false,
      vehicleConfirmedAt: r?.vehicleConfirmedAt ?? null,
    };
  });
}

/**
 * The booking-level milestone a trip's legs add up to, as a ride stage (ops.ts maps it onto the
 * booking's own status): the first leg's vehicle confirmed, then the trip under way from the first
 * pickup, then completed only when every leg is. Null while nothing has happened yet.
 */
export function tripMilestone(stages: readonly LegRideStatus[]): RideStatus | null {
  if (stages.length === 0) return null;
  if (stages.every((s) => s === 'completed')) return 'completed';
  if (stages.some((s) => s === 'on_trip' || s === 'completed')) return 'on_trip';
  if (stages[0] === 'vehicle_confirmed' || stages[0] === 'pickup_confirmed') return 'vehicle_confirmed';
  return null;
}
