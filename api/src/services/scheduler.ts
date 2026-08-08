import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { NotificationLogRepo, NotificationKind } from '../db/notificationLogRepo';
import type { EmailAdapter } from '../adapters/email';
import type { SendBudget } from './sendBudget';
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

const DAY_MS = 24 * 3600 * 1000;

/** One line of a dry run: what WOULD be sent, and to which booking. */
export interface PlannedSend {
  reference: string;
  kind: NotificationKind;
}

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
    // Blast-radius cap (R1). Optional: without one the sweep is uncapped, exactly as before.
    // The tick's other sweeps share this same budget, so the cap bounds the WHOLE tick.
    budget?: SendBudget;
    // Relevance window (R6) — never notify about a trip that ended more than this many days
    // ago. Unlike the ledger this is stateless, so an empty or restored notification_log
    // cannot resurrect an old booking: it fails the window before the ledger is consulted.
    maxTripAgeDays?: number;
    // Notification epoch (R6) — never notify about a booking TAKEN before this instant. The
    // window above only bounds trips in the past; a backfill writing FUTURE dates onto old
    // rows would sail straight through it. Booking creation time is the one input such a
    // backfill does not touch, which is what makes this the complementary guard.
    epoch?: Date;
    // Dry run (R7) — evaluate everything, write nothing, send nothing, and report the plan.
    // What you run after a migration touches booking state, before letting the real tick fire.
    dryRun?: boolean;
  },
): Promise<{ reminders: number; reviews: number; plan?: PlannedSend[] }> {
  const { bookings, log, email, baseUrl, linkSecret, budget, maxTripAgeDays, epoch, dryRun } = deps;
  const all = await bookings.list();
  let reminders = 0;
  let reviews = 0;
  const plan: PlannedSend[] = [];

  // The one place a send is authorised. Everything upstream decides WHETHER a booking is
  // eligible; this decides whether that eligibility becomes an email — ledger claim, cap,
  // and dry run all live here so no caller can accidentally bypass one.
  const dispatch = async (b: Booking, kind: NotificationKind, send: () => Promise<void>): Promise<boolean> => {
    if (dryRun) {
      // Planning consults the ledger read-only and spends the budget, so the plan reflects
      // what a real tick would do rather than an optimistic superset of it.
      if (await log.wasSent(b.id, kind)) return false;
      if (budget && !budget.tryClaim()) {
        budget.suppress(kind, b.reference);
        return false;
      }
      plan.push({ reference: b.reference, kind });
      return true;
    }
    if (!(await log.claim(b.id, kind))) return false;
    if (budget && !budget.tryClaim()) {
      await log.release(b.id, kind);
      budget.suppress(kind, b.reference);
      return false;
    }
    try {
      await send();
      return true;
    } catch (err) {
      await log.release(b.id, kind);
      console.error(`${kind} failed for ${b.reference}:`, err);
      return false;
    }
  };

  for (const b of all) {
    // Taken before we started notifying at all — fence it off whatever its dates say.
    if (epoch && Date.parse(b.createdAt) < epoch.getTime()) continue;

    const { start, end } = tripWindow(b);
    if (!start || !end) continue;

    // Too long ago to be worth an email from us, and far too long ago to be worth one
    // triggered by a data change nobody intended.
    if (maxTripAgeDays != null && now.getTime() - end.getTime() > maxTripAgeDays * DAY_MS) continue;

    const untilStart = start.getTime() - now.getTime();

    // Pre-trip reminder: trip STARTS within the lead window, and still active.
    if ((b.status === 'paid' || b.status === 'confirmed') && untilStart > 0 && untilStart <= REMINDER_LEAD_MS) {
      if (await dispatch(b, 'trip_reminder', () => sendTripReminder(b, email, { manage: manageUrl(b, baseUrl, linkSecret) }))) {
        reminders++;
      }
    }

    // Review request: the WHOLE trip is done (last leg completed, or comfortably in the
    // past), never cancelled — so a multi-day trip isn't asked for a review on day one.
    const sinceEnd = now.getTime() - end.getTime();
    const travelled = TRAVELLED_STATUSES.includes(b.status);
    if (travelled && (b.status === 'completed' || sinceEnd > REVIEW_DELAY_MS)) {
      if (await dispatch(b, 'review_request', () => sendReviewRequest(b, email))) {
        reviews++;
      }
    }
  }

  return { reminders, reviews, ...(dryRun ? { plan } : {}) };
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
