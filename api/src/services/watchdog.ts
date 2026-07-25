import type { BookingRepo } from '../db/bookingRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { AlertAdapter } from '../adapters/alerts';
import type { EmailAdapter } from '../adapters/email';
import { sendPaymentIncomplete, manageUrl } from './notifications';

// M17 payments watchdog — the periodic sweep behind POST /admin/jobs/watchdog. Catches
// the two silent money-path failures the inline webhook alerts can't see:
//  - a customer who started checkout but whose payment never settled (stuck pending);
//  - a PAID booking whose confirmation email never went out (customer heard nothing).
// Alerts are deduped per booking id, so the external ~15-min cron re-raises a persisting
// problem at most once per alert cooldown.

const STUCK_PENDING_MS = 30 * 60_000;
// Past this, a payment_pending booking is almost certainly an abandoned checkout, not a
// PayHere notify failure (PayHere retries notifications for minutes, not many hours). Only
// page inside the window — otherwise abandoned private/trip carts, which never leave
// payment_pending (only shared holds are swept), would re-alert on every ~15-min sweep forever.
const STUCK_PENDING_MAX_MS = 6 * 3600_000;
const UNCONFIRMED_PAID_MS = 15 * 60_000;

export async function runWatchdog(
  now: Date,
  deps: {
    bookings: BookingRepo;
    log: NotificationLogRepo;
    alerts: AlertAdapter;
    // When provided, an abandoned checkout also gets ONE customer recovery email
    // (idempotent via the notification log) with a link to finish paying.
    email?: EmailAdapter;
    baseUrl?: string;
    linkSecret?: string;
  },
): Promise<{ stuckPending: number; paidUnconfirmed: number; recoveryEmails: number }> {
  const { bookings, log, alerts, email, baseUrl, linkSecret } = deps;

  const pending = await bookings.list({ status: 'payment_pending' });
  const stuck = pending.filter((b) => {
    // Ops-booked bookings (channel 'whatsapp') are paid out-of-band / settled via the
    // payment-link flow, not web checkout — the abandoned-cart sweep (ops alert + customer
    // "finish paying" email) must never fire for them.
    if (b.channel === 'whatsapp') return false;
    const age = now.getTime() - Date.parse(b.createdAt);
    return age >= STUCK_PENDING_MS && age < STUCK_PENDING_MAX_MS;
  });
  let recoveryEmails = 0;
  for (const b of stuck) {
    await alerts.send({
      severity: 'critical',
      kind: 'watchdog_stuck_pending',
      title: `Booking ${b.reference} stuck in payment_pending`,
      body: `Booking ${b.reference} (${b.currency} ${(b.amountDueNow ?? b.total) / 100}) has been payment_pending since ${b.createdAt}. PayHere may have failed to notify, or the customer abandoned at the gateway.`,
      dedupeKey: b.id,
    });
    // One-shot customer recovery email. Best-effort: a mail hiccup must not abort the
    // sweep (the ops alert above already fired). Idempotent via notification_log.
    if (email && baseUrl && linkSecret && !(await log.wasSent(b.id, 'payment_recovery'))) {
      try {
        await sendPaymentIncomplete(b, email, { resume: manageUrl(b, baseUrl, linkSecret) });
        await log.markSent(b.id, 'payment_recovery');
        recoveryEmails += 1;
      } catch (err) {
        console.error(`payment-recovery email failed for ${b.reference}:`, err);
      }
    }
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

  return { stuckPending: stuck.length, paidUnconfirmed, recoveryEmails };
}
