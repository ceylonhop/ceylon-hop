import { Hono, type Context } from 'hono';
import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { DepartureRepo } from '../db/departureRepo';
import type { EmailAdapter } from '../adapters/email';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import { BOOKING_STATUSES, type BookingStatus, IllegalTransitionError } from '../domain/status';
import { sendCancellationConfirmation, sendRefundConfirmation } from '../services/notifications';
import { runScheduledNotifications, sweepStaleSharedHolds } from '../services/scheduler';

// Interim staff API guarded by a single shared key. Supabase Auth + RBAC replaces this
// in M12 — do not bake the API-key assumption deep.
export function adminRoutes(deps: {
  bookings: BookingRepo;
  departures: DepartureRepo;
  email: EmailAdapter;
  notificationLog: NotificationLogRepo;
  adminApiKey: string;
}) {
  const { bookings, departures, email, notificationLog, adminApiKey } = deps;
  const r = new Hono();

  const authed = (c: Context) => Boolean(adminApiKey) && c.req.header('x-admin-key') === adminApiKey;

  r.get('/bookings', async (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);

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
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
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

  r.post('/bookings/:id/cancel', (c) => transitionAndNotify(c, 'cancelled', sendCancellationConfirmation));
  r.post('/bookings/:id/refund', (c) => transitionAndNotify(c, 'refunded', sendRefundConfirmation));

  // Cron tick — an external scheduler (cron-job.org / GitHub Actions) POSTs here on a
  // cadence; the work is idempotent via the notification log, so over-calling is harmless.
  // The stale shared-hold sweep (GL-3) rides the same tick, best-effort: a sweep failure
  // must never block the notifications the caller asked for.
  r.post('/jobs/notifications', async (c) => {
    if (!authed(c)) return c.json({ error: 'unauthorized' }, 401);
    const result = await runScheduledNotifications(new Date(), { bookings, log: notificationLog, email });
    let staleSharedHolds = 0;
    try {
      staleSharedHolds = (await sweepStaleSharedHolds({ bookings, departures, now: new Date() })).swept;
    } catch (err) {
      console.error('stale shared-hold sweep failed:', err);
    }
    return c.json({ ...result, staleSharedHolds }, 200);
  });

  return r;
}
