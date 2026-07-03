import { eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { rideOps } from './schema';
import { assertRideTransition, type RideStatus } from '../domain/rideStatus';
import type { RideOpsRepo, RideOps } from './rideOpsRepo';

type Row = typeof rideOps.$inferSelect;
const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);
const toRideOps = (r: Row): RideOps => ({
  bookingId: r.bookingId,
  fulfilmentStatus: r.fulfilmentStatus as RideStatus,
  vehiclePhotoReceived: r.vehiclePhotoReceived,
  customerUpdated: r.customerUpdated,
  opsNotes: r.opsNotes,
  vehicleConfirmedAt: iso(r.vehicleConfirmedAt),
  updatedAt: r.updatedAt.toISOString(),
});

export class PostgresRideOpsRepo implements RideOpsRepo {
  constructor(private readonly db: Db) {}

  async getOrCreate(bookingId: string): Promise<RideOps> {
    const existing = await this.get(bookingId);
    if (existing) return existing;
    await this.db.insert(rideOps).values({ bookingId }).onConflictDoNothing();
    return (await this.get(bookingId))!;
  }

  async get(bookingId: string): Promise<RideOps | null> {
    const [row] = await this.db.select().from(rideOps).where(eq(rideOps.bookingId, bookingId));
    return row ? toRideOps(row) : null;
  }

  async setStatus(bookingId: string, to: RideStatus): Promise<RideOps> {
    const r = await this.getOrCreate(bookingId);
    assertRideTransition(r.fulfilmentStatus, to);
    const set: Partial<Row> = { fulfilmentStatus: to, updatedAt: new Date() };
    if (to === 'vehicle_confirmed') set.vehicleConfirmedAt = new Date();
    const [row] = await this.db.update(rideOps).set(set).where(eq(rideOps.bookingId, bookingId)).returning();
    return toRideOps(row);
  }

  async setFlags(
    bookingId: string,
    flags: { vehiclePhotoReceived?: boolean; customerUpdated?: boolean; opsNotes?: string | null },
  ): Promise<RideOps> {
    await this.getOrCreate(bookingId);
    const set: Partial<Row> = { updatedAt: new Date() };
    if (flags.vehiclePhotoReceived !== undefined) set.vehiclePhotoReceived = flags.vehiclePhotoReceived;
    if (flags.customerUpdated !== undefined) set.customerUpdated = flags.customerUpdated;
    if (flags.opsNotes !== undefined) set.opsNotes = flags.opsNotes;
    const [row] = await this.db.update(rideOps).set(set).where(eq(rideOps.bookingId, bookingId)).returning();
    return toRideOps(row);
  }

  async listByBookingIds(ids: string[]): Promise<RideOps[]> {
    if (ids.length === 0) return [];
    const rows = await this.db.select().from(rideOps).where(inArray(rideOps.bookingId, ids));
    return rows.map(toRideOps);
  }
}
