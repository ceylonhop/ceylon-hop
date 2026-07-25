import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { EmailAdapter } from '../adapters/email';
import { sendTripReminder, sendReviewRequest, manageUrl } from './notifications';

// A booking gets a pre-trip reminder once it's within this window of departure, and a
// review request once travel is this far in the past. The cron tick is idempotent via
// the notification log, so cadence (hourly/daily) only affects timeliness, never dupes.
const REMINDER_LEAD_MS = 48 * 3600 * 1000;
// A full day after the trip ends — a few hours on we can't be sure the customer has
// actually finished travelling, so we wait a day before asking "how was your trip?".
const REVIEW_DELAY_MS = 24 * 3600 * 1000;

// When the booking's trip STARTS and ENDS, as Dates. A single/shared booking is one leg
// (start === end). A multi-stop trip starts at its first dated leg and ends at its last —
// so the pre-trip reminder anchors to the start, but the review request waits until the
// WHOLE trip is over, not day one (BI6). Time is only known for single transfers (noon else).
function tripWindow(b: Booking): { start: Date | null; end: Date | null } {
  const toDate = (date: string, time?: string): Date | null => {
    const d = new Date(`${date}T${time ?? '12:00'}:00`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  if (b.mode === 'trip') {
    const dates = (b.input.dates ?? []).filter(Boolean).slice().sort();
    if (!dates.length) return { start: null, end: null };
    return { start: toDate(dates[0]), end: toDate(dates[dates.length - 1]) };
  }
  if (!b.input.date) return { start: null, end: null };
  const at = toDate(b.input.date, b.input.time);
  return { start: at, end: at };
}

const TRAVELLED_STATUSES = ['paid', 'confirmed', 'in_progress', 'completed'];

// Drive the scheduled customer emails. Pure over (now, repos) so it's deterministic in
// tests; the cron endpoint calls it with the real clock.
export async function runScheduledNotifications(
  now: Date,
  deps: {
    bookings: BookingRepo;
    log: NotificationLogRepo;
    email: EmailAdapter;
    // Signs the customer's "manage my booking" link in the trip reminder email.
    baseUrl: string;
    linkSecret: string;
  },
): Promise<{ reminders: number; reviews: number }> {
  const { bookings, log, email, baseUrl, linkSecret } = deps;
  const all = await bookings.list();
  let reminders = 0;
  let reviews = 0;

  for (const b of all) {
    const { start, end } = tripWindow(b);
    if (!start || !end) continue;
    const untilStart = start.getTime() - now.getTime();

    // Pre-trip reminder: trip STARTS within the lead window, and still active.
    if ((b.status === 'paid' || b.status === 'confirmed') && untilStart > 0 && untilStart <= REMINDER_LEAD_MS) {
      if (!(await log.wasSent(b.id, 'trip_reminder'))) {
        try {
          await sendTripReminder(b, email, { manage: manageUrl(b, baseUrl, linkSecret) });
          await log.markSent(b.id, 'trip_reminder');
          reminders++;
        } catch (err) {
          console.error(`trip reminder failed for ${b.reference}:`, err);
        }
      }
    }

    // Review request: the WHOLE trip is done (last leg completed, or comfortably in the
    // past), never cancelled — so a multi-day trip isn't asked for a review on day one.
    const sinceEnd = now.getTime() - end.getTime();
    const travelled = TRAVELLED_STATUSES.includes(b.status);
    if (travelled && (b.status === 'completed' || sinceEnd > REVIEW_DELAY_MS)) {
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

// GL-3 — an abandoned shared checkout holds real seats. After this long unpaid, the draft
// is cancelled and its seats go back on sale.
const STALE_HOLD_MS = 24 * 3600 * 1000;

// Cancel shared bookings stuck in draft/payment_pending for over 24h and free their
// seats. Pure over (now, repos) like runScheduledNotifications; the cron tick drives it.
// Per-booking best-effort: one bad row must not strand the rest of the sweep.
export async function sweepStaleSharedHolds(deps: {
  bookings: BookingRepo;
  departures: DepartureRepo;
  now: Date;
}): Promise<{ swept: number }> {
  const { bookings, departures, now } = deps;
  let swept = 0;
  for (const status of ['draft', 'payment_pending'] as const) {
    for (const b of await bookings.list({ status })) {
      if (b.mode !== 'shared') continue;
      if (now.getTime() - Date.parse(b.createdAt) <= STALE_HOLD_MS) continue;
      try {
        await bookings.setStatus(b.id, 'cancelled');
        await departures.releaseSeats({
          corridorId: b.input.corridorId,
          date: b.input.date,
          time: b.input.time,
          seats: b.input.seats,
        });
        swept++;
      } catch (err) {
        console.error(`stale shared-hold sweep failed for ${b.reference}:`, err);
      }
    }
  }
  return { swept };
}
