import type { Db } from './client';
import { opsUserProfiles } from './schema';
import { normaliseProfile, type OpsUserProfileRepo } from './opsUserProfileRepo';

export class PostgresOpsUserProfileRepo implements OpsUserProfileRepo {
  constructor(private readonly db: Db) {}

  // Upsert, because this fires on every sign-in and every app boot: the second call for a
  // person must refresh the name (they changed their Google profile) rather than collide.
  async upsert(email: string, name: string): Promise<void> {
    const row = normaliseProfile(email, name);
    if (!row) return;
    await this.db
      .insert(opsUserProfiles)
      .values({ email: row.email, name: row.name })
      .onConflictDoUpdate({
        target: opsUserProfiles.email,
        set: { name: row.name, updatedAt: new Date() },
      });
  }

  // The whole table: it holds one row per staff member (3 today), so the roster join is a
  // full read rather than a per-email round trip.
  async namesByEmail(): Promise<Map<string, string>> {
    const rows = await this.db.select().from(opsUserProfiles);
    return new Map(rows.map((r) => [r.email, r.name]));
  }
}
