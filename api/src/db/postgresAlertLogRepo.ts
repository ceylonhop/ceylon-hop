import { and, eq, gte, sql as dsql } from 'drizzle-orm';
import type { Db } from './client';
import { alertLog } from './schema';
import type { AlertLogRepo } from './alertLogRepo';

// Persisted alert-dedupe ledger — survives restarts/deploys so a redeploy can't re-spam
// the founder. shouldSend is a single atomic upsert: concurrent ticks racing on the same
// (kind, dedupe_key) resolve on the unique constraint, and exactly one caller sees the
// cooldown as expired.
export class PostgresAlertLogRepo implements AlertLogRepo {
  constructor(private readonly db: Db) {}

  async shouldSend(kind: string, dedupeKey: string, cooldownMs: number, now: Date): Promise<boolean> {
    // Raw Date params inside sql`` fragments bypass drizzle's column serialization and the
    // postgres driver rejects them — pass ISO strings and cast to timestamptz explicitly.
    const cutoffIso = new Date(now.getTime() - cooldownMs).toISOString();
    const nowIso = now.toISOString();
    const rows = await this.db
      .insert(alertLog)
      .values({ kind, dedupeKey, lastSentAt: now, count: 1 })
      .onConflictDoUpdate({
        target: [alertLog.kind, alertLog.dedupeKey],
        set: {
          count: dsql`CASE WHEN ${alertLog.lastSentAt} <= ${cutoffIso}::timestamptz THEN 1 ELSE ${alertLog.count} + 1 END`,
          lastSentAt: dsql`CASE WHEN ${alertLog.lastSentAt} <= ${cutoffIso}::timestamptz THEN ${nowIso}::timestamptz ELSE ${alertLog.lastSentAt} END`,
        },
      })
      .returning({ lastSentAt: alertLog.lastSentAt });
    // Delivered iff the row's last_sent_at is the timestamp we just tried to write.
    return rows[0]?.lastSentAt?.getTime() === now.getTime();
  }

  // BI3 — undo an optimistic reservation when the delivery failed, so the alert isn't
  // suppressed for a cooldown. Guarded on last_sent_at = reservedAt so a concurrent
  // successful send that overwrote the row is never clobbered. Deleting the row (rather than
  // resetting the timestamp) also keeps the failed send out of the digest's countsSince.
  async rollback(kind: string, dedupeKey: string, reservedAt: Date): Promise<void> {
    await this.db
      .delete(alertLog)
      .where(
        and(
          eq(alertLog.kind, kind),
          eq(alertLog.dedupeKey, dedupeKey),
          eq(alertLog.lastSentAt, reservedAt),
        ),
      );
  }

  // Digest approximation: kinds whose most recent delivery falls in the window. (The
  // table keeps one row per key, not a send history — good enough for a daily digest.)
  async countsSince(since: Date): Promise<Record<string, number>> {
    const rows = await this.db
      .select({ kind: alertLog.kind })
      .from(alertLog)
      .where(gte(alertLog.lastSentAt, since));
    const out: Record<string, number> = {};
    for (const r of rows) out[r.kind] = (out[r.kind] || 0) + 1;
    return out;
  }
}
