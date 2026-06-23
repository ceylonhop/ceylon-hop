import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { notificationLog } from './schema';
import type { NotificationLogRepo, NotificationKind } from './notificationLogRepo';

// Persisted dedup ledger — survives restarts/deploys so a redeploy can't re-send
// reminders. markSent relies on the (booking_id, kind) unique constraint for atomic
// idempotency under concurrent ticks.
export class PostgresNotificationLogRepo implements NotificationLogRepo {
  constructor(private readonly db: Db) {}

  async wasSent(bookingId: string, kind: NotificationKind): Promise<boolean> {
    const rows = await this.db
      .select()
      .from(notificationLog)
      .where(and(eq(notificationLog.bookingId, bookingId), eq(notificationLog.kind, kind)));
    return rows.length > 0;
  }

  async markSent(bookingId: string, kind: NotificationKind): Promise<void> {
    await this.db.insert(notificationLog).values({ bookingId, kind }).onConflictDoNothing();
  }
}
