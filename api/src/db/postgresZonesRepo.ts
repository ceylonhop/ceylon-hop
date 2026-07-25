import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { pricingZones } from './schema';
import { hotZonesDisabled, toHotZone, type ZonesRepo, type ZoneRow, type NewZone, type ZonePatch } from './zonesRepo';
import type { HotZone } from '../quote/hotZones';

type Row = typeof pricingZones.$inferSelect;

function toRow(r: Row): ZoneRow {
  return {
    id: r.id,
    placeName: r.placeName,
    boostPct: r.boostPct,
    active: r.active,
    lat: r.lat,
    lng: r.lng,
    radiusKm: r.radiusKm,
    createdBy: r.createdBy,
    updatedBy: r.updatedBy,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
  };
}

export class PostgresZonesRepo implements ZonesRepo {
  constructor(private readonly db: Db) {}

  async activeZones(): Promise<HotZone[]> {
    if (hotZonesDisabled()) return [];
    const rows = await this.db.select().from(pricingZones).where(eq(pricingZones.active, true));
    return rows.map((r) => toHotZone(toRow(r)));
  }

  async list(): Promise<ZoneRow[]> {
    const rows = await this.db.select().from(pricingZones).orderBy(desc(pricingZones.createdAt));
    return rows.map(toRow);
  }

  async get(id: string): Promise<ZoneRow | null> {
    const rows = await this.db.select().from(pricingZones).where(eq(pricingZones.id, id)).limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async create(z: NewZone): Promise<ZoneRow> {
    const rows = await this.db
      .insert(pricingZones)
      .values({
        placeName: z.placeName,
        boostPct: z.boostPct,
        active: z.active ?? true,
        lat: z.lat ?? null,
        lng: z.lng ?? null,
        radiusKm: z.radiusKm ?? null,
        createdBy: z.createdBy ?? null,
        updatedBy: z.updatedBy ?? null,
      })
      .returning();
    return toRow(rows[0]);
  }

  async patch(id: string, p: ZonePatch): Promise<ZoneRow | null> {
    // Build the SET map from only the provided fields, so a partial patch never clobbers a column.
    const set: Partial<typeof pricingZones.$inferInsert> = { updatedAt: new Date() };
    if (p.placeName !== undefined) set.placeName = p.placeName;
    if (p.boostPct !== undefined) set.boostPct = p.boostPct;
    if (p.active !== undefined) set.active = p.active;
    if (p.lat !== undefined) set.lat = p.lat;
    if (p.lng !== undefined) set.lng = p.lng;
    if (p.radiusKm !== undefined) set.radiusKm = p.radiusKm;
    if (p.updatedBy !== undefined) set.updatedBy = p.updatedBy;
    const rows = await this.db.update(pricingZones).set(set).where(eq(pricingZones.id, id)).returning();
    return rows[0] ? toRow(rows[0]) : null;
  }

  async remove(id: string): Promise<boolean> {
    const rows = await this.db.delete(pricingZones).where(eq(pricingZones.id, id)).returning({ id: pricingZones.id });
    return rows.length > 0;
  }
}
