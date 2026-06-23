import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { EmailAdapter } from '../adapters/email';
import { sendTripReminder, sendReviewRequest } from './notifications';

// A booking gets a pre-trip reminder once it's within this window of departure, and a
// review request once travel is this far in the past. The cron tick is idempotent via
// the notification log, so cadence (hourly/daily) only affects timeliness, never dupes.
const REMINDER_LEAD_MS = 48 * 3600 * 1000;
const REVIEW_DELAY_MS = 3 * 3600 * 1000;

// When the booking travels, as a Date. Trips use the first dated leg (time unknown → noon).
function travelAt(b: Booking): Date | null {
  let date: string | undefined;
  let time: string | undefined;
  if (b.mode === 'trip') {
    date = b.input.dates?.find(Boolean);
  } else {
    date = b.input.date;
    time = b.input.time;
  }
  if (!date) return null;
  const d = new Date(`${date}T${time ?? '12:00'}:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

const TRAVELLED_STATUSES = ['paid', 'confirmed', 'in_progress', 'completed'];

// Drive the scheduled customer emails. Pure over (now, repos) so it's deterministic in
// tests; the cron endpoint calls it with the real clock.
export async function runScheduledNotifications(
  now: Date,
  deps: { bookings: BookingRepo; log: NotificationLogRepo; email: EmailAdapter },
): Promise<{ reminders: number; reviews: number }> {
  const { bookings, log, email } = deps;
  const all = await bookings.list();
  let reminders = 0;
  let reviews = 0;

  for (const b of all) {
    const at = travelAt(b);
    if (!at) continue;
    const ms = at.getTime() - now.getTime();

    // Pre-trip reminder: upcoming within the lead window, and still active.
    if ((b.status === 'paid' || b.status === 'confirmed') && ms > 0 && ms <= REMINDER_LEAD_MS) {
      if (!(await log.wasSent(b.id, 'trip_reminder'))) {
        try {
          await sendTripReminder(b, email);
          await log.markSent(b.id, 'trip_reminder');
          reminders++;
        } catch (err) {
          console.error(`trip reminder failed for ${b.reference}:`, err);
        }
      }
    }

    // Review request: travel is done (completed, or comfortably in the past), never cancelled.
    const travelled = TRAVELLED_STATUSES.includes(b.status);
    if (travelled && (b.status === 'completed' || ms < -REVIEW_DELAY_MS)) {
      if (!(await log.wasSent(b.id, 'review_request'))) {
        try {
          await sendReviewRequest(b, email);
          await log.markSent(b.id, 'review_request');
          reviews++;
        } catch (err) {
          console.error(`review request failed for ${b.reference}:`, err);
        }
      }
    }
  }

  return { reminders, reviews };
}
