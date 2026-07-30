import { Hono, type Context } from 'hono';
import { z } from 'zod';
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
import { sweepAbandonedDrafts } from '../services/abandonedDrafts';
import { runWatchdog } from '../services/watchdog';
import { buildDigest } from '../services/digest';
import type { AlertAdapter } from '../adapters/alerts';
import type { AlertLogRepo } from '../db/alertLogRepo';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { RefundError, type RefundRepo } from '../db/refundRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RideOpsRepo } from '../db/rideOpsRepo';

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
  refunds: RefundRepo;
  // Manual settlement (mark-paid) needs the payment ledger to record the money and the ride-ops
  // row to write the audit note the booking sheet's activity list renders.
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
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
  const RefundRequest = z
    .object({
      amountCents: z.number().int().positive(),
      currency: z.string().length(3),
      reason: z.string().trim().min(1).max(500),
    })
    .strict();
  const RefundConfirm = z.object({ gatewayRef: z.string().trim().min(1).max(200) }).strict();

  const refundError = (c: Context, error: unknown) => {
    if (!(error instanceof RefundError)) throw error;
    if (error.code === 'booking_not_found' || error.code === 'refund_not_found') {
      return c.json({ error: error.code }, 404);
    }
    return c.json({ error: error.code }, 409);
  };

  r.get('/bookings/:id/refunds', requireCap('payments:act'), async (c) => {
    if (!(await bookings.get(c.req.param('id')))) return c.json({ error: 'booking_not_found' }, 404);
    return c.json(await deps.refunds.list(c.req.param('id')), 200);
  });

  r.post('/bookings/:id/refunds', requireCap('payments:act'), async (c) => {
    const parsed = RefundRequest.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_refund_request' }, 400);
    try {
      const refund = await deps.refunds.request({
        bookingId: c.req.param('id'),
        ...parsed.data,
        currency: parsed.data.currency.toUpperCase(),
        requestedBy: c.get('identity').email,
      });
      return c.json(refund, 201);
    } catch (error) {
      return refundError(c, error);
    }
  });

  r.post('/bookings/:id/refunds/:refundId/confirm', requireCap('payments:act'), async (c) => {
    const parsed = RefundConfirm.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'gateway_ref_required' }, 400);
    const before = await bookings.get(c.req.param('id'));
    if (!before) return c.json({ error: 'booking_not_found' }, 404);
    try {
      const outcome = await deps.refunds.confirm({
        bookingId: c.req.param('id'),
        refundId: c.req.param('refundId'),
        gatewayRef: parsed.data.gatewayRef,
        confirmedBy: c.get('identity').email,
      });
      const after = await bookings.get(c.req.param('id'));
      if (!after) throw new Error(`booking_not_found_after_refund: ${c.req.param('id')}`);
      if (outcome.bookingFullyRefunded && after.mode === 'shared' && before.status !== 'cancelled') {
        try {
          await departures.releaseSeats({
            corridorId: after.input.corridorId,
            date: after.input.date,
            time: after.input.time,
            seats: after.input.seats,
          });
        } catch (error) {
          console.error(`seat release failed for ${after.reference}:`, error);
        }
      }
      try {
        await sendRefundConfirmation(
          after,
          email,
          outcome.refund.amountCents,
          outcome.refund.currency,
        );
      } catch (error) {
        console.error(`refund email failed for ${after.reference}:`, error);
      }
      return c.json(outcome, 200);
    } catch (error) {
      return refundError(c, error);
    }
  });

  r.post('/bookings/:id/refunds/:refundId/cancel', requireCap('payments:act'), async (c) => {
    try {
      return c.json(
        await deps.refunds.cancel({
          bookingId: c.req.param('id'),
          refundId: c.req.param('refundId'),
        }),
        200,
      );
    } catch (error) {
      return refundError(c, error);
    }
  });
  // Ops marks the booking confirmed once the driver's arranged (paid → confirmed).
  // No customer email on this transition (owner decision 2026-07-18): the paid
  // confirmation already went out, so confirming the driver is an internal step.
  r.post('/bookings/:id/confirm', requireCap('payments:act'), (c) =>
    transitionAndNotify(c, 'confirmed', async () => {}),
  );
  // Ops marks a no-show (confirmed/in_progress → no_show); fare is forfeited.
  r.post('/bookings/:id/no-show', requireCap('payments:act'), (c) => transitionAndNotify(c, 'no_show', sendNoShowNotice));

  const MarkPaid = z
    .object({
      method: z.enum(['cash', 'bank_transfer', 'manual_other']),
      reference: z.string().trim().min(1).max(200).optional(),
    })
    .strict();

  // Ops marks an out-of-band booking paid (owner 2026-07-30). A booking converted from a
  // quote lands in payment_pending and is settled by cash or bank transfer, so no PayHere
  // webhook is ever coming — without this it is stranded at "Awaiting payment" forever and
  // can never advance through the pipeline. The money is RECORDED, not just asserted: a
  // refund requires a captured payment (refundRepo's payment_not_captured), so a status-only
  // flip would leave a cash booking unrefundable.
  // Deliberately sends NO customer email (owner 2026-07-30); automatic sending is wanted
  // later and belongs with the rest of the confirmation flow.
  r.post('/bookings/:id/mark-paid', requireCap('payments:act'), async (c) => {
    const booking = await bookings.get(c.req.param('id'));
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const parsed = MarkPaid.safeParse(await c.req.json().catch(() => null));
    if (!parsed.success) return c.json({ error: 'invalid_mark_paid_request' }, 400);
    const { method } = parsed.data;
    const reference = parsed.data.reference ?? null;

    // Idempotent on a key derived from the booking id, the same way POST /admin/quote/:id/book
    // is: a double-click finds the payment it already recorded and returns the booking as it
    // stands rather than taking the money twice.
    // Only a SUCCEEDED payment may short-circuit. create() claims the key with a 'pending' row,
    // so a settle step that dies mid-flight (a 23505 on the provider/gateway-reference UNIQUE
    // when one bank slip is entered on two bookings, or any transient connection error) leaves
    // that row behind: short-circuiting on its mere existence would answer every retry with a
    // cheerful 200 and an unchanged booking — stranded forever with no repair path, which is the
    // exact condition this route exists to end. Falling through is safe because create() returns
    // the existing row for a claimed key, so the settle and status steps simply re-run.
    const idempotencyKey = `manual-paid:${booking.id}`;
    const claimed = await deps.payments.findByIdempotencyKey(idempotencyKey);
    if (claimed && claimed.status === 'succeeded') return c.json(booking, 200);

    if (booking.status !== 'payment_pending') {
      return c.json({ error: 'not_awaiting_payment', status: booking.status }, 400);
    }
    // Defence in depth: if some other payment already settled — a PayHere webhook arriving late
    // on a booking ops decided to settle by hand — refuse rather than record a second one. Two
    // succeeded rows on one booking double the captured total refundRepo sums, which would make
    // refund_exceeds_captured wave through a refund of twice the money actually taken.
    const settled = (await deps.payments.findByBookingId(booking.id)).some((p) => p.status === 'succeeded');
    if (settled) return c.json({ error: 'already_paid', status: booking.status }, 409);

    const payment = await deps.payments.create({
      bookingId: booking.id,
      // The method is genuinely the provider of this money — a cash payment's provider is cash.
      // The CHECK `payments_provider_supported` admits all three manual methods alongside the two
      // gateways since migration 0029; it is a typo guard on channel names, not a safety property.
      provider: method,
      // Not the bare booking reference: the checkout route already claims that as its orderId,
      // and order_id is unique — a booking once handed a PayHere form must still be settleable
      // in cash.
      orderId: `${booking.reference}-MANUAL`,
      amount: booking.amountDueNow ?? booking.total,
      currency: booking.currency,
      idempotencyKey,
    });
    await deps.payments.markSucceededManually(payment.id, { reference });

    let paid: Booking;
    try {
      paid = await bookings.setStatus(booking.id, 'paid');
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
      // A webhook or a concurrent mark-paid moved the booking between the guard and here. The
      // money is recorded either way, so report the booking as it now stands, not a 500.
      paid = (await bookings.get(booking.id)) ?? booking;
    }

    // Audit trail: who took the money, how, and against what reference. It goes in the ops
    // notes because that is what the booking sheet's activity list renders (one note per line);
    // best-effort like the emails above — a note failure must not undo money already recorded.
    try {
      const ops = await deps.rideOps.getOrCreate(booking.id);
      const note = `Marked paid — ${method} · ${reference ?? 'no reference'} · by ${c.get('identity').email}`;
      await deps.rideOps.setFlags(booking.id, { opsNotes: ops.opsNotes ? `${ops.opsNotes}\n${note}` : note });
    } catch (err) {
      console.error(`mark-paid note failed for ${paid.reference}:`, err);
    }
    return c.json(paid, 200);
  });

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
    // Abandoned autosave shells ride the same tick, best-effort: "+ New quote" creates a real
    // row so the ticket is assignable immediately, and this is what stops the unfinished ones
    // accumulating. Idempotent (a soft-deleted row no longer lists) and a failure here must
    // never block the customer notifications the caller asked for.
    let abandonedDrafts = 0;
    if (deps.quotes) {
      try {
        abandonedDrafts = (await sweepAbandonedDrafts(new Date(), { quotes: deps.quotes })).swept;
      } catch (err) {
        console.error('abandoned-draft sweep failed:', err);
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
    return c.json({ ...result, staleSharedHolds, expiredQuotes, abandonedDrafts, digest, rideBoard }, 200);
  });

  // M17 — payments watchdog tick. Idempotent (alerts dedupe per booking inside their
  // cooldown); driven every ~15 min by the external cron with the x-admin-key header.
  r.post('/jobs/watchdog', requireCap('admin:jobs'), async (c) => {
    const result = await runWatchdog(new Date(), { bookings, log: notificationLog, alerts, email, baseUrl, linkSecret });
    return c.json(result, 200);
  });

  return r;
}
