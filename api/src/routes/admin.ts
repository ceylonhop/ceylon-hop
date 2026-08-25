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
import { SendBudget, burstAlert } from '../services/sendBudget';
import { buildDigest } from '../services/digest';
import type { AlertAdapter } from '../adapters/alerts';
import type { AlertLogRepo } from '../db/alertLogRepo';
import { opsIdentity, requireCap, type OpsAuthConfig } from '../lib/opsMiddleware';
import { MANUAL_PAYMENT_METHODS } from '../domain/paymentMethod';
import { releaseWonQuote, claimWonQuote } from '../services/quoteOutcome';
import { RefundError, type RefundConfirmation, type RefundRepo } from '../db/refundRepo';
import type { PaymentAdapter } from '../adapters/payments';
import { mayReverse } from '../domain/reversalWindow';
import type { StatusAudit } from '../db/bookingRepo';
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
  // The gateway itself, for API refunds. Optional: without it (or without an adapter that
  // implements refund()) the execute route 409s and ops uses the manual dashboard flow, which
  // is a supported state rather than a degraded one.
  paymentAdapter?: PaymentAdapter;
  // Manual settlement (mark-paid) needs the payment ledger to record the money and the ride-ops
  // row to write the audit note the booking sheet's activity list renders.
  payments: PaymentRepo;
  rideOps: RideOpsRepo;
  // Blast-radius cap (docs/notification-safety-rails-spec.md R1) — the most notifications
  // ONE tick may send before it stops and pages. Optional so existing callers/tests keep
  // their uncapped behaviour; the production mount always passes config.NOTIFY_MAX_PER_RUN.
  notifyMaxPerRun?: number;
  // Relevance window + epoch (R6). Both optional; unset means unbounded, as before.
  notifyMaxTripAgeDays?: number;
  notifyEpoch?: Date;
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
    audit?: StatusAudit,
  ) {
    const id = c.req.param('id');
    if (!id) return c.json({ error: 'not_found' }, 404);
    const booking = await bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    let updated: Booking;
    try {
      updated = await bookings.setStatus(id, to, audit);
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
    // A cancelled booking's source quote is no longer won — see services/quoteOutcome. Not
    // for no_show: the fare is forfeited, so that one really was won. Best-effort.
    if (to === 'cancelled') await releaseWonQuote(updated.id, 'Booking cancelled', deps);
    try {
      await notify(updated, email);
    } catch (err) {
      console.error(`${to} email failed for ${updated.reference}:`, err);
    }
    return c.json(updated, 200);
  }

  // Owner rule (2026-08-02): an ops agent may cancel up to 24 hours before the trip starts and
  // must say why; inside that last day only a founder may. Capability is 'bookings:operate' —
  // the narrower 'payments:reverse' is founder-only and stays that way, with the time-bounded
  // grant applied by reversalGate() below so the rule is readable in one place.
  const CancelRequest = z.object({ reason: z.string().trim().min(1).max(500) }).strict();

  // Shared by all four reversal routes. Returns a Response to send, or null to proceed.
  const reversalGate = async (c: Context, bookingId: string): Promise<Response | null> => {
    const booking = await bookings.get(bookingId);
    if (!booking) return c.json({ error: 'booking_not_found' }, 404);
    const verdict = mayReverse(c.get('identity').role, booking);
    if (verdict.ok) return null;
    return c.json({ error: verdict.code, message: verdict.message }, 403);
  };

  r.post('/bookings/:id/cancel', requireCap('bookings:operate'), async (c) => {
    const id = c.req.param('id');
    const blocked = await reversalGate(c, id);
    if (blocked) return blocked;
    const parsed = CancelRequest.safeParse(await c.req.json().catch(() => null));
    // A reason is required, not encouraged: a time-bounded grant is only auditable if the
    // reason and the actor are actually written down.
    if (!parsed.success) return c.json({ error: 'cancellation_reason_required' }, 400);
    return transitionAndNotify(c, 'cancelled', sendCancellationConfirmation, {
      reason: parsed.data.reason,
      by: c.get('identity').email,
    });
  });
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

  // Reading refund history stays on payments:act — finance must be able to reconcile the books
  // without being able to move money. Only the four REVERSAL routes below are founder-only.
  r.get('/bookings/:id/refunds', requireCap('payments:act'), async (c) => {
    if (!(await bookings.get(c.req.param('id')))) return c.json({ error: 'booking_not_found' }, 404);
    return c.json(await deps.refunds.list(c.req.param('id')), 200);
  });

  r.post('/bookings/:id/refunds', requireCap('bookings:operate'), async (c) => {
    const blocked = await reversalGate(c, c.req.param('id'));
    if (blocked) return blocked;
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

  // Everything that must happen once money has actually gone back, whoever moved it — the
  // manual dashboard flow or the Refund API. Shared so the two paths cannot drift: a refund
  // confirmed by API must release the same seats and send the same email as one confirmed by
  // hand. Every side effect is best-effort; none may fail the refund that already happened.
  const afterRefundConfirmed = async (
    bookingId: string,
    statusBefore: string,
    outcome: RefundConfirmation,
  ): Promise<void> => {
    const after = await bookings.get(bookingId);
    if (!after) throw new Error(`booking_not_found_after_refund: ${bookingId}`);
    // Money fully returned ⇒ the quote behind it was not won after all. A PARTIAL refund
    // leaves it won: we kept part of the fare, so the business did happen.
    if (outcome.bookingFullyRefunded) await releaseWonQuote(after.id, 'Booking refunded', deps);
    if (outcome.bookingFullyRefunded && after.mode === 'shared' && statusBefore !== 'cancelled') {
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
      await sendRefundConfirmation(after, email, outcome.refund.amountCents, outcome.refund.currency);
    } catch (error) {
      console.error(`refund email failed for ${after.reference}:`, error);
    }
  };

  // Confirm and cancel-request carry the SAME gate as the request. The money actually moves at
  // confirm, so the protected last day has to be protected there too; if ops runs out of window
  // mid-flow a founder finishes it, and nothing is stranded.
  r.post('/bookings/:id/refunds/:refundId/confirm', requireCap('bookings:operate'), async (c) => {
    const blocked = await reversalGate(c, c.req.param('id'));
    if (blocked) return blocked;
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
      await afterRefundConfirmed(c.req.param('id'), before.status, outcome);
      return c.json(outcome, 200);
    } catch (error) {
      return refundError(c, error);
    }
  });

  // Refund through PayHere's API instead of by hand. Same gate as confirm — this is the moment
  // money moves, so the protected last day is protected here too.
  //
  // The order below is the entire safety design and must not be rearranged:
  //   1. beginApi() claims the row as api_processing and commits, BEFORE any HTTP call
  //   2. the gateway is called
  //   3. only a DEFINITE answer settles the row
  // An indefinite answer leaves it in api_processing on purpose. PayHere's Refund API has no
  // idempotency key, so a retry against an unknown outcome is how a customer is refunded twice.
  r.post('/bookings/:id/refunds/:refundId/execute', requireCap('bookings:operate'), async (c) => {
    const blocked = await reversalGate(c, c.req.param('id'));
    if (blocked) return blocked;
    const adapter = deps.paymentAdapter;
    if (!adapter?.refund) return c.json({ error: 'refund_api_unavailable' }, 409);
    const before = await bookings.get(c.req.param('id'));
    if (!before) return c.json({ error: 'booking_not_found' }, 404);

    let started;
    try {
      started = await deps.refunds.beginApi({
        bookingId: c.req.param('id'),
        refundId: c.req.param('refundId'),
      });
    } catch (error) {
      return refundError(c, error);
    }

    // From here the row is api_processing and the money is in play. Nothing below may throw
    // its way past the settle step without leaving the row for a human.
    let result;
    try {
      result = await adapter.refund({
        gatewayPaymentId: started.gatewayPaymentId,
        amountCents: started.refund.amountCents,
        currency: started.refund.currency,
        description: started.refund.reason,
        isFullRefund: started.isFullRefund,
      });
    } catch (error) {
      // An adapter that threw rather than returning told us nothing about the money.
      result = { outcome: 'unknown' as const, providerMessage: `threw: ${(error as Error).message}` };
    }

    if (result.outcome === 'unknown') {
      void alerts.send({
        severity: 'critical',
        kind: 'refund_api_indeterminate',
        title: `Refund outcome unknown for ${before.reference}`,
        body:
          `A refund of ${started.refund.amountCents / 100} ${started.refund.currency} was sent to PayHere ` +
          `for booking ${before.reference} and we never learned the outcome ` +
          `(${result.providerMessage ?? 'no detail'}). The money MAY have moved.\n\n` +
          `Do NOT retry. Open PayHere > Payments, find payment ${started.gatewayPaymentId}, and either ` +
          `confirm this refund with its reference or, if no refund exists, cancel and re-request.`,
        dedupeKey: started.refund.id,
      });
      return c.json(
        { error: 'refund_outcome_unknown', refundId: started.refund.id, providerMessage: result.providerMessage },
        202,
      );
    }

    try {
      const outcome = await deps.refunds.settleApi({
        bookingId: c.req.param('id'),
        refundId: c.req.param('refundId'),
        outcome:
          result.outcome === 'succeeded'
            ? { kind: 'succeeded', gatewayRef: result.gatewayRef!, providerMessage: result.providerMessage }
            : { kind: 'failed', providerMessage: result.providerMessage ?? 'refund declined by gateway' },
        confirmedBy: c.get('identity').email,
      });
      if (result.outcome === 'failed') {
        return c.json({ error: 'refund_declined', refund: outcome.refund }, 409);
      }
      await afterRefundConfirmed(c.req.param('id'), before.status, outcome);
      return c.json(outcome, 200);
    } catch (error) {
      // PayHere said the refund happened and we could not write it down — the worst possible
      // place to fail, and precisely why it alerts rather than 500s silently.
      void alerts.send({
        severity: 'critical',
        kind: 'refund_api_unrecorded',
        title: `Refund made but NOT recorded for ${before.reference}`,
        body:
          `PayHere reported outcome "${result.outcome}"` +
          (result.gatewayRef ? ` (ref ${result.gatewayRef})` : '') +
          ` for booking ${before.reference}, and writing it to the ledger failed: ` +
          `${(error as Error).message}. Reconcile by hand.`,
        dedupeKey: started.refund.id,
      });
      return refundError(c, error);
    }
  });

  r.post('/bookings/:id/refunds/:refundId/cancel', requireCap('bookings:operate'), async (c) => {
    const blocked = await reversalGate(c, c.req.param('id'));
    if (blocked) return blocked;
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
      method: z.enum(MANUAL_PAYMENT_METHODS),
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
    // The money of an earlier attempt is already in the ledger; only the booking may still be
    // behind. Short-circuit ONLY once the booking has actually reached paid — the second half of
    // the same window as the pending case above: if setStatus threw something other than an
    // IllegalTransitionError (a pool timeout, a connection blip), the payment is succeeded while
    // the booking sits in payment_pending, and nothing else can move it (no webhook is coming for
    // cash, and confirm/cancel/no-show do not start from payment_pending). Answering 200 with the
    // unchanged booking would strand it for good, repairable only by hand-written SQL in prod.
    const recorded = claimed?.status === 'succeeded';
    if (recorded && booking.status === 'paid') return c.json(booking, 200);

    if (booking.status !== 'payment_pending') {
      return c.json({ error: 'not_awaiting_payment', status: booking.status }, 400);
    }

    // Only when the money still has to be taken. On the repair path above it is already recorded,
    // so create/settle must not run again — and neither may the ledger guard, whose succeeded row
    // is OUR OWN: it would turn a legitimate repair into a 409 and leave the booking stranded.
    if (!recorded) {
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
      // The actor goes in a COLUMN, not just the ops note below: that note is editable via
      // /flags by the `ops` role, which is denied payments:act (0043).
      await deps.payments.markSucceededManually(payment.id, { reference, settledBy: c.get('identity').email });
    }

    let paid: Booking;
    try {
      paid = await bookings.setStatus(booking.id, 'paid');
    } catch (err) {
      if (!(err instanceof IllegalTransitionError)) throw err;
      // A webhook or a concurrent mark-paid moved the booking between the guard and here. The
      // money is recorded either way, so report the booking as it now stands, not a 500.
      paid = (await bookings.get(booking.id)) ?? booking;
    }

    // Cash landing wins the quote exactly like a webhook settle does (pay-link flow) —
    // an ops agent recording a bank transfer after sending a link is the same money.
    await claimWonQuote(booking.id, deps);

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
    // ONE budget for the whole tick: the scheduler and the Ride Board sweep both draw on
    // it, so the cap bounds everything this endpoint can send, not each sweep separately.
    const budget = deps.notifyMaxPerRun == null ? undefined : new SendBudget(deps.notifyMaxPerRun);
    const window = { maxTripAgeDays: deps.notifyMaxTripAgeDays, epoch: deps.notifyEpoch };

    // Dry run (R7): report what a real tick WOULD send and return. Deliberately returns
    // before every other sweep on this endpoint — the stale-hold, Ride Board, quote-expiry
    // and abandoned-draft passes all mutate, and "read-only" has to mean the whole tick or
    // it is not a safe thing to run after a migration.
    if (c.req.query('dryRun')) {
      const preview = await runScheduledNotifications(new Date(), {
        bookings, log: notificationLog, email, baseUrl, linkSecret, budget, ...window, dryRun: true,
      });
      return c.json({ ...preview, dryRun: true }, 200);
    }

    const result = await runScheduledNotifications(new Date(), { bookings, log: notificationLog, email, baseUrl, linkSecret, budget, ...window });
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
        const rb = await runRideBoardCutoff(new Date(), { rideLists: deps.rideLists, paygw: deps.ridePaygw, email, budget, alerts });
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
          await email.send({ to: deps.digestTo, subject: d.subject, html: d.html, text: d.text, audience: 'ops' });
          digest = true;
        } catch (err) {
          console.error('ops digest failed:', err);
        }
      }
    }
    // The digest above is an OPS email, not a customer one, so it is deliberately outside
    // the budget — same reasoning as the watchdog's alerts.
    const burst = budget && burstAlert(budget, 'notifications');
    if (burst) await alerts.send(burst);
    return c.json(
      { ...result, staleSharedHolds, expiredQuotes, abandonedDrafts, digest, rideBoard, suppressed: budget?.report().suppressed ?? 0 },
      200,
    );
  });

  // M17 — payments watchdog tick. Idempotent (alerts dedupe per booking inside their
  // cooldown); driven every ~15 min by the external cron with the x-admin-key header.
  r.post('/jobs/watchdog', requireCap('admin:jobs'), async (c) => {
    const budget = deps.notifyMaxPerRun == null ? undefined : new SendBudget(deps.notifyMaxPerRun);
    const result = await runWatchdog(new Date(), { bookings, log: notificationLog, alerts, email, baseUrl, linkSecret, payments: deps.payments, refunds: deps.refunds, budget });
    const burst = budget && burstAlert(budget, 'watchdog');
    if (burst) await alerts.send(burst);
    return c.json({ ...result, suppressed: budget?.report().suppressed ?? 0 }, 200);
  });

  return r;
}
