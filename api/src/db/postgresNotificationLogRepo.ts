import { and, eq } from 'drizzle-orm';
import type { Db } from './client';
import { notificationLog } from './schema';
import type { NotificationLogRepo, NotificationKind } from './notificationLogRepo';

// Persisted dedup ledger — survives restarts/deploys so a redeploy can't re-send
// reminders. claim() is where the atomicity actually lives: the (booking_id, kind) unique
// constraint makes the insert the arbitrator, so of two concurrent ticks exactly one gets
// a row back and sends. markSent alone never did that — it deduped rows, not emails.
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

  async claim(bookingId: string, kind: NotificationKind): Promise<boolean> {
    // RETURNING is empty when the conflict fired, i.e. someone else already owns this send.
    const rows = await this.db
      .insert(notificationLog)
      .values({ bookingId, kind })
      .onConflictDoNothing()
      .returning({ bookingId: notificationLog.bookingId });
    return rows.length > 0;
  }

  async release(bookingId: string, kind: NotificationKind): Promise<void> {
    await this.db
      .delete(notificationLog)
      .where(and(eq(notificationLog.bookingId, bookingId), eq(notificationLog.kind, kind)));
  }
}
