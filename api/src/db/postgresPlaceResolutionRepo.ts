import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { placeResolutions } from './schema';
import { canonPlace } from '../adapters/maps';
import type { NewPlaceResolution, PlaceResolution, PlaceResolutionRepo } from './placeResolutionRepo';

type Row = typeof placeResolutions.$inferSelect;

const toDomain = (r: Row): PlaceResolution => ({
  id: r.id,
  canonKey: r.canonKey,
  displayName: r.displayName,
  lat: r.lat,
  lng: r.lng,
  source: r.source as PlaceResolution['source'],
  confirmedBy: r.confirmedBy,
  confirmedAt: r.confirmedAt,
  createdAt: r.createdAt,
});

export class PostgresPlaceResolutionRepo implements PlaceResolutionRepo {
  constructor(private readonly db: Db) {}

  async get(canonKey: string): Promise<PlaceResolution | null> {
    const rows = await this.db
      .select()
      .from(placeResolutions)
      .where(eq(placeResolutions.canonKey, canonPlace(canonKey)))
      .limit(1);
    return rows[0] ? toDomain(rows[0]) : null;
  }

  async all(): Promise<PlaceResolution[]> {
    return (await this.db.select().from(placeResolutions)).map(toDomain);
  }

  async upsert(row: NewPlaceResolution): Promise<PlaceResolution> {
    const key = canonPlace(row.canonKey);
    const source = row.source ?? 'confirmed';
    const values = {
      canonKey: key,
      displayName: row.displayName,
      lat: row.lat,
      lng: row.lng,
      source,
      confirmedBy: row.confirmedBy ?? null,
      confirmedAt: source === 'catalog' ? null : new Date(),
    };
    // Idempotent on canon_key: two operators confirming the same string at once must not 23505.
    const [saved] = await this.db
      .insert(placeResolutions)
      .values(values)
      .onConflictDoUpdate({ target: placeResolutions.canonKey, set: values })
      .returning();
    return toDomain(saved);
  }
}
