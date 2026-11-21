import { eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { rideOpsLegs } from './schema';
import type { LegRideStatus } from '../domain/tripLegStage';
import { assertLegTransition, type RideOpsLeg, type RideOpsLegFlags, type RideOpsLegRepo } from './rideOpsLegRepo';

type Row = typeof rideOpsLegs.$inferSelect;
const toRideOpsLeg = (r: Row): RideOpsLeg => ({
  legId: r.legId,
  fulfilmentStatus: r.fulfilmentStatus as LegRideStatus,
  vehiclePhotoReceived: r.vehiclePhotoReceived,
  customerUpdated: r.customerUpdated,
  vehicleConfirmedAt: r.vehicleConfirmedAt ? r.vehicleConfirmedAt.toISOString() : null,
  updatedAt: r.updatedAt.toISOString(),
});

export class PostgresRideOpsLegRepo implements RideOpsLegRepo {
  constructor(private readonly db: Db) {}

  async get(legId: string): Promise<RideOpsLeg | null> {
    const [row] = await this.db.select().from(rideOpsLegs).where(eq(rideOpsLegs.legId, legId));
    return row ? toRideOpsLeg(row) : null;
  }

  async setStatus(legId: string, to: LegRideStatus): Promise<RideOpsLeg> {
    // Checked before the row is created, so a refused move on an untouched leg leaves no row.
    assertLegTransition((await this.get(legId))?.fulfilmentStatus ?? 'paid', to);
    await this.db.insert(rideOpsLegs).values({ legId }).onConflictDoNothing();
    const set: Partial<Row> = { fulfilmentStatus: to, updatedAt: new Date() };
    if (to === 'vehicle_confirmed') set.vehicleConfirmedAt = new Date();
    const [row] = await this.db.update(rideOpsLegs).set(set).where(eq(rideOpsLegs.legId, legId)).returning();
    return toRideOpsLeg(row);
  }

  async setFlags(legId: string, flags: RideOpsLegFlags): Promise<RideOpsLeg> {
    await this.db.insert(rideOpsLegs).values({ legId }).onConflictDoNothing();
    const set: Partial<Row> = { updatedAt: new Date() };
    if (flags.vehiclePhotoReceived !== undefined) set.vehiclePhotoReceived = flags.vehiclePhotoReceived;
    if (flags.customerUpdated !== undefined) set.customerUpdated = flags.customerUpdated;
    const [row] = await this.db.update(rideOpsLegs).set(set).where(eq(rideOpsLegs.legId, legId)).returning();
    return toRideOpsLeg(row);
  }

  async listByLegIds(ids: string[]): Promise<RideOpsLeg[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(rideOpsLegs).where(inArray(rideOpsLegs.legId, ids));
    return rows.map(toRideOpsLeg);
  }
}
