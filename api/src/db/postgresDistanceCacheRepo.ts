import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { distanceCache } from './schema';
import type { DistanceCacheRepo, DistanceCacheRow, NewDistanceCacheRow } from './distanceCacheRepo';

function toRow(r: typeof distanceCache.$inferSelect): DistanceCacheRow {
  return {
    fromKey: r.fromKey,
    toKey: r.toKey,
    km: r.km,
    durationMin: r.durationMin,
    source: 'google',
    fetchedAt: r.fetchedAt,
  };
}

export class PostgresDistanceCacheRepo implements DistanceCacheRepo {
  constructor(private readonly db: Db) {}

  async get(fromKey: string, toKey: string): Promise<DistanceCacheRow | null> {
    const rows = await this.db
      .select()
      .from(distanceCache)
      .where(and(eq(distanceCache.fromKey, fromKey), eq(distanceCache.toKey, toKey)))
      .limit(1);
    return rows[0] ? toRow(rows[0]) : null;
  }

  async upsert(r: NewDistanceCacheRow): Promise<DistanceCacheRow> {
    const rows = await this.db
      .insert(distanceCache)
      .values({ fromKey: r.fromKey, toKey: r.toKey, km: r.km, durationMin: r.durationMin })
      .onConflictDoUpdate({
        target: [distanceCache.fromKey, distanceCache.toKey],
        set: { km: r.km, durationMin: r.durationMin, fetchedAt: new Date() },
      })
      .returning();
    return toRow(rows[0]);
  }

  async all(): Promise<DistanceCacheRow[]> {
    return (await this.db.select().from(distanceCache)).map(toRow);
  }
}
