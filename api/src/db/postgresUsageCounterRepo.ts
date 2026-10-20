import { and, asc, gte, lte, sql } from 'drizzle-orm';
import type { Db } from './client';
import { usageCounters } from './schema';
import type { UsageCounterRepo, UsageCounterRow } from './usageCounterRepo';

// Postgres usage counters (spec 2026-10-13 §1). add() is one atomic upsert that ADDS, so the
// coalesced flushes from UsageMeter — or two instances during a deploy overlap — never lose a count.
export class PostgresUsageCounterRepo implements UsageCounterRepo {
  constructor(private readonly db: Db) {}

  async add(day: string, key: string, n: number): Promise<void> {
    await this.db
      .insert(usageCounters)
      .values({ day, key, n })
      .onConflictDoUpdate({
        target: [usageCounters.day, usageCounters.key],
        set: { n: sql`${usageCounters.n} + excluded.n` },
      });
  }

  async range(fromDay: string, toDay: string): Promise<UsageCounterRow[]> {
    return this.db
      .select({ day: usageCounters.day, key: usageCounters.key, n: usageCounters.n })
      .from(usageCounters)
      .where(and(gte(usageCounters.day, fromDay), lte(usageCounters.day, toDay)))
      .orderBy(asc(usageCounters.day), asc(usageCounters.key));
  }
}
