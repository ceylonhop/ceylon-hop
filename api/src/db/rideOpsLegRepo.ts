import { assertRideTransition } from '../domain/rideStatus';
import type { LegRideStatus } from '../domain/tripLegStage';

// Per-leg ops steps (spec 2026-11-19): the ride_ops idea, one row per driven leg of a private
// multi-stop trip. Keyed by booking_legs.id — the only stable name a leg has. A leg with no row
// has not been touched and counts as 'paid', the same lazy pattern ride_ops uses.
export interface RideOpsLeg {
  legId: string;
  fulfilmentStatus: LegRideStatus;
  vehiclePhotoReceived: boolean;
  customerUpdated: boolean;
  vehicleConfirmedAt: string | null;
  updatedAt: string;
}

export type RideOpsLegFlags = { vehiclePhotoReceived?: boolean; customerUpdated?: boolean };

export interface RideOpsLegRepo {
  get(legId: string): Promise<RideOpsLeg | null>;
  setStatus(legId: string, to: LegRideStatus): Promise<RideOpsLeg>;
  setFlags(legId: string, flags: RideOpsLegFlags): Promise<RideOpsLeg>;
  /** Existing rows only — an untouched leg is absent, and is 'paid'. */
  listByLegIds(ids: string[]): Promise<RideOpsLeg[]>;
}

/** Throws unless `from → to` is a legal move for one leg. Shared by both repos. */
export function assertLegTransition(from: LegRideStatus, to: LegRideStatus): void {
  if ((to as string) === 'no_show') throw new Error('Illegal leg transition: no_show belongs to the booking');
  assertRideTransition(from, to);
}

function blank(legId: string): RideOpsLeg {
  return {
    legId, fulfilmentStatus: 'paid', vehiclePhotoReceived: false, customerUpdated: false,
    vehicleConfirmedAt: null, updatedAt: new Date().toISOString(),
  };
}

export class InMemoryRideOpsLegRepo implements RideOpsLegRepo {
  private byId = new Map<string, RideOpsLeg>();
  private touch(r: RideOpsLeg): RideOpsLeg { r.updatedAt = new Date().toISOString(); this.byId.set(r.legId, r); return { ...r }; }

  async get(legId: string): Promise<RideOpsLeg | null> {
    const r = this.byId.get(legId);
    return r ? { ...r } : null;
  }
  async setStatus(legId: string, to: LegRideStatus): Promise<RideOpsLeg> {
    const r = this.byId.get(legId) ?? blank(legId);
    assertLegTransition(r.fulfilmentStatus, to);
    r.fulfilmentStatus = to;
    if (to === 'vehicle_confirmed') r.vehicleConfirmedAt = new Date().toISOString();
    return this.touch(r);
  }
  async setFlags(legId: string, flags: RideOpsLegFlags): Promise<RideOpsLeg> {
    const r = this.byId.get(legId) ?? blank(legId);
    if (flags.vehiclePhotoReceived !== undefined) r.vehiclePhotoReceived = flags.vehiclePhotoReceived;
    if (flags.customerUpdated !== undefined) r.customerUpdated = flags.customerUpdated;
    return this.touch(r);
  }
  async listByLegIds(ids: string[]): Promise<RideOpsLeg[]> {
    return ids.map((id) => this.byId.get(id)).filter((r): r is RideOpsLeg => !!r).map((r) => ({ ...r }));
  }
}
