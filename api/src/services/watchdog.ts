import type { BookingRepo } from '../db/bookingRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { AlertAdapter } from '../adapters/alerts';

// M17 payments watchdog — the periodic sweep behind POST /admin/jobs/watchdog. Catches
// the two silent money-path failures the inline webhook alerts can't see:
//  - a customer who started checkout but whose payment never settled (stuck pending);
//  - a PAID booking whose confirmation email never went out (customer heard nothing).
// Alerts are deduped per booking id, so the external ~15-min cron re-raises a persisting
// problem at most once per alert cooldown.

const STUCK_PENDING_MS = 30 * 60_000;
const UNCONFIRMED_PAID_MS = 15 * 60_000;

export async function runWatchdog(
  now: Date,
  deps: { bookings: BookingRepo; log: NotificationLogRepo; alerts: AlertAdapter },
): Promise<{ stuckPending: number; paidUnconfirmed: number }> {
  const { bookings, log, alerts } = deps;

  const pending = await bookings.list({ status: 'payment_pending' });
  const stuck = pending.filter((b) => now.getTime() - Date.parse(b.createdAt) >= STUCK_PENDING_MS);
  for (const b of stuck) {
    await alerts.send({
      severity: 'critical',
      kind: 'watchdog_stuck_pending',
      title: `Booking ${b.reference} stuck in payment_pending`,
      body: `Booking ${b.reference} (${b.currency} ${(b.amountDueNow ?? b.total) / 100}) has been payment_pending since ${b.createdAt}. PayHere may have failed to notify, or the customer abandoned at the gateway.`,
      dedupeKey: b.id,
    });
  }

  const paid = await bookings.list({ status: 'paid' });
  let paidUnconfirmed = 0;
  for (const b of paid) {
    if (now.getTime() - Date.parse(b.createdAt) < UNCONFIRMED_PAID_MS) continue;
    if (await log.wasSent(b.id, 'confirmation')) continue;
    paidUnconfirmed += 1;
    await alerts.send({
      severity: 'critical',
      kind: 'watchdog_paid_unconfirmed',
      title: `Paid booking ${b.reference} has no confirmation email`,
      body: `Booking ${b.reference} is PAID but no confirmation send is recorded — the customer may not know their booking is confirmed. Resend it manually.`,
      dedupeKey: b.id,
    });
  }

  return { stuckPending: stuck.length, paidUnconfirmed };
}
