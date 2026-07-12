// Records which scheduled notifications have already gone out, so the cron tick is
// idempotent — a booking is never reminded or asked for a review twice. 'confirmation'
// (M17) records the post-payment confirmation email so the watchdog can spot paid
// bookings whose customer never got one.
export type NotificationKind = 'trip_reminder' | 'review_request' | 'confirmation' | 'payment_recovery';

export interface NotificationLogRepo {
  wasSent(bookingId: string, kind: NotificationKind): Promise<boolean>;
  markSent(bookingId: string, kind: NotificationKind): Promise<void>;
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
}
