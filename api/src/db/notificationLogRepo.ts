// Records which scheduled notifications have already gone out, so the cron tick is
// idempotent — a booking is never reminded or asked for a review twice. 'confirmation'
// (M17) records the post-payment confirmation email so the watchdog can spot paid
// bookings whose customer never got one.
export type NotificationKind =
  | 'trip_reminder'
  | 'review_request'
  | 'confirmation'
  | 'payment_failed'
  | 'payment_recovery'
  | 'deposit_received'
  | 'booking_confirmed'
  | 'no_show_notice';

export interface NotificationLogRepo {
  wasSent(bookingId: string, kind: NotificationKind): Promise<boolean>;
  markSent(bookingId: string, kind: NotificationKind): Promise<void>;
  /**
   * Reserve the right to send, atomically. True means this caller owns the send; false
   * means it is already sent, or another concurrent run owns it — either way, do nothing.
   *
   * Replaces the wasSent-then-send-then-markSent sequence on the CRON paths, where two
   * ticks (an external cron and a manual POST /admin/jobs/notifications) could both read
   * false and both send. The unique constraint always guaranteed one ROW; only claiming
   * before sending guarantees one EMAIL.
   *
   * The webhook paths deliberately still use wasSent/markSent — see the note on release().
   */
  claim(bookingId: string, kind: NotificationKind): Promise<boolean>;
  /**
   * Hand a claim back, so a later run may take it. Called when the send fails or is
   * suppressed by the burst cap.
   *
   * This is why claim-then-send is confined to the cron kinds: a process that dies between
   * claim and send leaves a row asserting an email nobody received, and release() cannot
   * run. For a reminder that is an acceptable loss — the next trip email covers it. For a
   * CONFIRMATION it is not, and worse, it would blind the watchdog's paid-unconfirmed
   * alarm, which finds exactly that condition by the ABSENCE of a row. Slice 4 makes
   * sent_at nullable so a claim is distinguishable from a send, and the webhook paths move
   * over then.
   */
  release(bookingId: string, kind: NotificationKind): Promise<void>;
}

export class InMemoryNotificationLogRepo implements NotificationLogRepo {
  private readonly sent = new Set<string>();
  private key(bookingId: string, kind: NotificationKind): string {
    return `${bookingId}:${kind}`;
  }
  async wasSent(bookingId: string, kind: NotificationKind): Promise<boolean> {
    return this.sent.has(this.key(bookingId, kind));
  }
  async markSent(bookingId: string, kind: NotificationKind): Promise<void> {
    this.sent.add(this.key(bookingId, kind));
  }
  async claim(bookingId: string, kind: NotificationKind): Promise<boolean> {
    const k = this.key(bookingId, kind);
    if (this.sent.has(k)) return false;
    this.sent.add(k);
    return true;
  }
  async release(bookingId: string, kind: NotificationKind): Promise<void> {
    this.sent.delete(this.key(bookingId, kind));
  }
}
