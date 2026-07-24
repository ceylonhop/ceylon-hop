import { Hono, type Context } from 'hono';
import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { EmailAdapter } from '../adapters/email';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { BOOKING_STATUSES, type BookingStatus, IllegalTransitionError } from '../domain/status';
import {
  sendCancellationConfirmation,
  sendRefundConfirmation,
  sendNoShowNotice,
} from '../services/notifications';
import { runScheduledNotifications, sweepStaleSharedHolds } from '../services/scheduler';
import { runRideBoardCutoff } from '../services/rideBoardCutoff';
import type { RideListRepo } from '../db/rideListRepo';
import type { TokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { expireStaleQuotes } from '../services/quoteExpiry';
import { runWatchdog } from '../services/watchdog';
import { buildDigest } from '../services/digest';
import type { AlertAdapter } from '../adapters/alerts';
import type { AlertLogRepo } from '../db/alertLogRepo';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';

// Capability-gated staff API (RBAC reconciliation, T-E): cancel/refund require a HUMAN
// session with payments:act (founder or finance) — the machine key (system) does NOT
// have payments:act, so a leaked x-admin-key can no longer issue refunds (spec D6).
// Cron/watchdog endpoints stay machine-driven via admin:jobs (system or founder).
export function adminRoutes(deps: {
  bookings: BookingRepo;
  departures: DepartureRepo;
  email: EmailAdapter;
  notificationLog: NotificationLogRepo;
  auth: OpsAuthConfig;
  // Optional so existing callers work; when wired, the notifications tick also expires stale
  // sent ops quotes (best-effort rider). See services/quoteExpiry.
  quotes?: QuoteRepo;
  // M17 — watchdog alert channel + digest inputs; all optional so existing callers work.
  alerts?: AlertAdapter;
  alertLog?: AlertLogRepo;
  digestTo?: string;
  // Digest dashboard link (Task 4), optional so the digest degrades gracefully without it.
  opsBaseUrl?: string;
  // Signs the customer's "manage my booking" link in the scheduled trip reminder email.
  baseUrl: string;
  linkSecret: string;
  // Ride Board cutoff sweep rides the same cron tick (best-effort). Optional so existing
  // callers work; when wired, the notifications tick also confirms/expires due lists.
  rideLists?: RideListRepo;
  ridePaygw?: TokenizedPaymentAdapter;
}) {
  const { bookings, departures, email, notificationLog, auth, baseUrl, linkSecret } = deps;
  const alerts: AlertAdapter = deps.alerts ?? { send: async () => {} };
  const r = new Hono();
  r.use('*', opsIdentity(auth));

  r.get('/bookings', requireCap('bookings:read'), async (c) => {
    const status = c.req.query('status');
    if (status && !(BOOKING_STATUSES as readonly string[]).includes(status)) {
      return c.json({ error: 'bad_status' }, 400);
    }
    const list = await bookings.list(status ? { status: status as BookingStatus } : undefined);
    return c.json(list, 200);
  });

  // Cancel / refund: guard the transition, then notify the customer (best-effort — a
  // mail hiccup must not undo the state change the staff member just made).
  async function transitionAndNotify(
    c: Context,
    to: BookingStatus,
    notify: (b: Booking, e: EmailAdapter) => Promise<void>,
  ) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found' }, 404);
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    let updated: Booking;
    try {
      updated = await bookings.setStatus(id, to);
    } catch (err) {
      if (err instanceof IllegalTransitionError) {
        return c.json({ error: 'illegal_transition', from: err.from, to: err.to }, 409);
      }
      throw err;
    }
    // GL-3 — a cancelled/refunded shared booking gives its seats back. Refunding an
    // already-cancelled booking must NOT release again (the cancel already did — a second
    // decrement would free someone else's seats). Best-effort like the email below.
    if (updated.mode === 'shared' && !(to === 'refunded' && booking.status === 'cancelled')) {
      try {
        await departures.releaseSeats({
          corridorId: updated.input.corridorId,
          date: updated.input.date,
          time: updated.input.time,
          seats: updated.input.seats,
        });
      } catch (err) {
        console.error(`seat release failed for ${updated.reference}:`, err);
      }
    }
    try {
      await notify(updated, email);
    } catch (err) {
      console.error(`${to} email failed for ${updated.reference}:`, err);
    }
    return c.json(updated, 200);
  }

  r.post('/bookings/:id/cancel', requireCap('payments:act'), (c) => transitionAndNotify(c, 'cancelled', sendCancellationConfirmation));
  r.post('/bookings/:id/refund', requireCap('payments:act'), (c) => transitionAndNotify(c, 'refunded', sendRefundConfirmation));
  // Ops marks the booking confirmed once the driver's arranged (paid → confirmed).
  // No customer email on this transition (owner decision 2026-07-18): the paid
  // confirmation already went out, so confirming the driver is an internal step.
  r.post('/bookings/:id/confirm', requireCap('payments:act'), (c) =>
    transitionAndNotify(c, 'confirmed', async () => {}),
  );
  // Ops marks a no-show (confirmed/in_progress → no_show); fare is forfeited.
  r.post('/bookings/:id/no-show', requireCap('payments:act'), (c) => transitionAndNotify(c, 'no_show', sendNoShowNotice));

  // Cron tick — an external scheduler (cron-job.org / GitHub Actions) POSTs here on a
  // cadence; the work is idempotent via the notification log, so over-calling is harmless.
  // The stale shared-hold sweep (GL-3) rides the same tick, best-effort: a sweep failure
  // must never block the notifications the caller asked for.
  r.post('/jobs/notifications', requireCap('admin:jobs'), async (c) => {
    const result = await runScheduledNotifications(new Date(), { bookings, log: notificationLog, email, baseUrl, linkSecret });
    let staleSharedHolds = 0;
    try {
      staleSharedHolds = (await sweepStaleSharedHolds({ bookings, departures, now: new Date() })).swept;
    } catch (err) {
      console.error('stale shared-hold sweep failed:', err);
    }
    // Ride Board cutoff (confirm/charge or expire due lists) rides the same tick, best-effort.
    let rideBoard = { processed: 0, confirmed: 0, expired: 0 };
    if (deps.rideLists && deps.ridePaygw) {
      try {
        const rb = await runRideBoardCutoff(new Date(), { rideLists: deps.rideLists, paygw: deps.ridePaygw, email });
        rideBoard = { processed: rb.processed, confirmed: rb.confirmed, expired: rb.expired };
      } catch (err) {
        console.error('ride-board cutoff sweep failed:', err);
      }
    }
    // Quote expiry rides the same tick, best-effort: close ops quotes sat unanswered in 'sent'
    // past the idle TTL. Idempotent (an expired quote no longer matches), and a failure here
    // must never block the customer notifications the caller asked for.
    let expiredQuotes = 0;
    if (deps.quotes) {
      try {
        expiredQuotes = (await expireStaleQuotes(new Date(), { quotes: deps.quotes })).expired;
      } catch (err) {
        console.error('quote expiry sweep failed:', err);
      }
    }
    // M17: the daily ops digest rides the same daily tick, best-effort — a digest
    // failure must never block the customer notifications the caller asked for.
    let digest = false;
    if (deps.digestTo) {
      // Once-per-day guard (BI4): an external cron may POST this tick several times a day,
      // but the founder should get ONE digest. Gate on the alert-dedupe ledger — a 20h
      // cooldown ≈ daily. Without a ledger (some tests) keep the prior always-send behaviour.
      const DIGEST_COOLDOWN_MS = 20 * 3600_000;
      const doDigest =
        !deps.alertLog || (await deps.alertLog.shouldSend('ops_digest', 'daily', DIGEST_COOLDOWN_MS, new Date()));
      if (doDigest) {
        try {
          const d = await buildDigest(new Date(), { bookings, alertLog: deps.alertLog, quotes: deps.quotes, opsBaseUrl: deps.opsBaseUrl });
          await email.send({ to: deps.digestTo, subject: d.subject, html: d.html, text: d.text });
          digest = true;
        } catch (err) {
          console.error('ops digest failed:', err);
        }
      }
    }
    return c.json({ ...result, staleSharedHolds, expiredQuotes, digest, rideBoard }, 200);
  });

  // M17 — payments watchdog tick. Idempotent (alerts dedupe per booking inside their
  // cooldown); driven every ~15 min by the external cron with the x-admin-key header.
  r.post('/jobs/watchdog', requireCap('admin:jobs'), async (c) => {
    const result = await runWatchdog(new Date(), { bookings, log: notificationLog, alerts, email, baseUrl, linkSecret });
    return c.json(result, 200);
  });

  return r;
}
