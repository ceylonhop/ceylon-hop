import { Hono, type MiddlewareHandler } from 'hono';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { PaymentAdapter, WebhookRejection } from '../adapters/payments';
import type { EmailAdapter } from '../adapters/email';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { AlertAdapter } from '../adapters/alerts';
import {
  PaymentSettlementError,
  type PaymentSettlementRepo,
} from '../db/paymentSettlementRepo';
import { wasDelivered } from '../adapters/email';
import { sendBookingConfirmation, sendDetailsNeeded, sendPaymentFailed, sendDepositReceived, needsDetails, manageUrl, routeText, travelWhenText } from '../services/notifications';
import { money as fmtMoney } from '../services/opsEmail';
import { teamPaidEmail, teamRescueEmail } from '../services/opsNotifications';
import type { Booking } from '../db/bookingRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import {
  recordCheckoutEvent,
  type BookingCheckoutEventInput,
  type BookingCheckoutEventRepo,
  type CheckoutOutcome,
} from '../db/bookingCheckoutEventRepo';
import type { ProviderPaymentStatus } from '../adapters/payments';
import { claimWonQuote } from '../services/quoteOutcome';
import { closeOlderDuplicates, type DuplicateCloseDeps } from '../services/duplicateBookings';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

// What the on-call reader needs in order to act: is this ours or a stranger's, and if it is
// ours, which order. The body hash is here so two alerts can be compared (or matched against a
// server log line) without the body itself — it can carry the payer's name and card number.
function describeRejection(
  reason: string,
  isSignature: boolean,
  rejection: WebhookRejection | null,
): string {
  if (isSignature) {
    return [
      'A payment notification arrived correctly shaped but with a signature we could not verify.',
      'Either PAYHERE_MERCHANT_SECRET is wrong, or someone is probing the endpoint. If other',
      'payments are settling normally the secret is fine and this is a probe.',
      rejection?.orderId ? `\nClaimed order: ${rejection.orderId}` : '',
      rejection ? `\nBody sha256: ${rejection.bodySha256}` : '',
    ].join(' ').trim();
  }
  const facts = rejection
    ? [
        ['order', rejection.orderId],
        ['status_code', rejection.statusCode],
        ['amount', rejection.amount],
        ['currency', rejection.currency],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${v}`)
    : [];
  return [
    `A payment notification was refused before verification: ${reason}.`,
    'The signature was never reached, so this does NOT implicate the merchant secret — either a',
    'stranger posted to the endpoint, or PayHere sent something our field rules do not accept.',
    'If the fields below name a real order, treat it as the latter and reconcile that booking by hand.',
    facts.length ? `\n${facts.join(' · ')}` : '\nNo recognisable PayHere fields in the body.',
    rejection ? `\nBody sha256: ${rejection.bodySha256}` : '',
  ].join(' ').trim();
}

// Plain-text body for the team's paid notification. Deliberately the few facts an operator
// acts on — who, where, how much, which channel — and nothing that would make this email a
// place anyone has to go looking for the rest.
function teamPaidBody(b: Booking): string {
  const c = b.input.customer;
  return [
    `${routeText(b)}`,
    // When they travel — omitted until 2026-09-22, so the one message telling the team a seat
    // sold could not tell them it departs in two days. The timestamp the alert transport adds
    // at the foot of that email is the send time, which is when the money landed (CH-6HE3V).
    `Travels ${travelWhenText(b)}`,
    `${c.firstName} ${c.lastName} · ${c.email} · ${c.whatsapp}`,
    `${fmtMoney(b.total, b.currency)} · booked via ${b.channel}`,
    `Reference ${b.reference}`,
  ].join('\n');
}

// What PayHere's notify said, in the attempt log's words (0055). Recorded whatever the
// settlement then made of it: a duplicate or a reversal is still "the gateway said 2".
const NOTIFY_OUTCOME: Record<ProviderPaymentStatus, CheckoutOutcome> = {
  succeeded: 'settled', // 2
  failed: 'failed', // -2
  cancelled: 'dismissed', // -1
  pending: 'pending', // 0
  charged_back: 'failed', // -3
};

// The attempt-log row a webhook request will write, set by the handler where the outcome is
// decided and written once the response is known (so http_status is the real one).
type WebhookVars = { Variables: { checkoutEvent?: Omit<BookingCheckoutEventInput, 'source' | 'httpStatus' | 'ua'> } };

export function webhookRoutes(deps: {
  settlements: PaymentSettlementRepo;
  // Pay links (2026-07-31): settlement is what wins a quote, so the webhook needs the
  // quote repo to flip the one behind this booking. Optional: without it (older tests)
  // settlement behaves exactly as before.
  quotes?: QuoteRepo;
  adapter: PaymentAdapter;
  email: EmailAdapter;
  conciergeTasks: ConciergeTaskRepo;
  // M17 — optional so existing callers/tests keep working; alerts default to no-op.
  alerts?: AlertAdapter;
  notificationLog?: NotificationLogRepo;
  // Enables POST /webhooks/resend (bounce/complaint alerts). Unset → endpoint 404s.
  resendWebhookSecret?: string;
  // Signs the customer's "manage my booking" link in the confirmation email.
  baseUrl: string;
  linkSecret: string;
  // Deep link in the team's paid email. Unset → the email says where to look instead.
  opsBaseUrl?: string;
  // Checkout attempt log (db/bookingCheckoutEventRepo.ts). Unset → nothing is recorded.
  checkoutEvents?: BookingCheckoutEventRepo;
  // Closes the same customer's older unpaid bookings for the same trip once one settles
  // (services/duplicateBookings.ts). Unset → nothing is closed, as before.
  duplicates?: Omit<DuplicateCloseDeps, 'alerts'>;
}) {
  const { settlements, adapter, email, conciergeTasks, notificationLog, baseUrl, linkSecret } = deps;
  const alerts: AlertAdapter = deps.alerts ?? { send: async () => {} };
  const r = new Hono<WebhookVars>();

  // Writes the row the handler prepared, after the response exists. Best-effort, never awaited.
  const logAttempt: MiddlewareHandler<WebhookVars> = async (c, next) => {
    await next();
    const e = c.get('checkoutEvent');
    if (!e) return;
    const status = c.res.status;
    recordCheckoutEvent(deps.checkoutEvents, {
      ...e,
      ...(status >= 500 ? { outcome: 'error', reason: c.error?.message ?? 'server_error' } : {}),
      httpStatus: status,
      ua: c.req.header('user-agent')?.slice(0, 300) ?? null,
      source: 'server',
    });
  };

  // 5.3 — payment webhook. Verifies signature, reconciles the amount, marks the payment
  // succeeded and the booking paid — idempotently — then sends the confirmation (5.4).
  // M17: the silent failure paths now raise throttled ops alerts.
  r.post('/payments', logAttempt, async (c) => {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const isExpectedContentType = adapter.provider !== 'payhere' || contentType === 'application/x-www-form-urlencoded';
    const rawBody = await c.req.text();
    const event = isExpectedContentType ? adapter.parseWebhook(rawBody) : null;
    if (!event) {
      // An EMPTY body is not a lost payment notification, and alerting on one is a false
      // positive by construction: PayHere never sends an empty notify, and the promote
      // checklist's own §5 liveness probe is literally `curl -X POST -d ''` against this route.
      // Every "PayHere webhook rejected" CRITICAL email on 2026-08-02/03 was that probe — the
      // checklist and the alerting were manufacturing pages for each other, which is exactly
      // how a team learns to skim past a CRITICAL subject line.
      //
      // Still a 401: the request is refused as firmly as before. Only the page is dropped.
      if (rawBody.length === 0) return c.json({ error: 'invalid_signature' }, 401);
      // This alert used to say "invalid signature — misconfigured merchant secret or someone
      // probing", for all eleven-odd ways a body can be refused. On 2026-08-02 it fired while a
      // customer's card was being declined, and the owner had no way to tell whether PayHere's
      // notify had been thrown away or a bot had poked the URL. Only `signature_mismatch` means
      // what the old copy claimed; the rest mean we refused a body the gateway may have meant.
      const rejection: WebhookRejection | null = isExpectedContentType
        ? adapter.describeWebhookRejection?.(rawBody) ?? null
        : { reason: 'content_type_unexpected', bodySha256: sha256(rawBody) };
      const reason = rejection?.reason ?? 'unknown';
      const isSignature = reason === 'signature_mismatch';
      c.set('checkoutEvent', { action: 'webhook', outcome: 'refused', reason, orderId: rejection?.orderId ?? null });
      void alerts.send({
        severity: 'critical',
        kind: isSignature ? 'payhere_signature' : 'payhere_webhook_rejected',
        title: isSignature
          ? 'PayHere webhook signature failed'
          : `PayHere webhook rejected (${reason})`,
        body: describeRejection(reason, isSignature, rejection),
        // Was the bare date — one alert per DAY, so a real rejected notify and a scanner probe
        // collapsed into each other and the second one was never seen. Per reason per day keeps
        // distinct failures distinct while still capping a storm.
        dedupeKey: `${new Date().toISOString().slice(0, 10)}:${reason}`,
      });
      return c.json({ error: 'invalid_signature' }, 401);
    }

    let outcome;
    try {
      outcome = await settlements.acceptVerifiedEvent(event);
    } catch (error) {
      if (!(error instanceof PaymentSettlementError)) throw error;
      c.set('checkoutEvent', {
        action: 'webhook', outcome: 'refused', reason: error.code, orderId: event.orderId,
        bookingId: error.payment?.bookingId ?? null,
      });
      if (error.code === 'unknown_order') return c.json({ error: 'unknown_order' }, 404);
      const payment = error.payment;
      void alerts.send({
        severity: 'critical',
        kind: 'payhere_amount',
        title: `PayHere amount mismatch on order ${event.orderId}`,
        body: payment
          ? `expected ${payment.amount} ${payment.currency}, webhook says ${event.amountCents} ${event.currency}`
          : `Payment amount/currency mismatch for ${event.orderId}`,
        dedupeKey: event.orderId,
      });
      return c.json({ error: 'amount_mismatch' }, 400);
    }

    c.set('checkoutEvent', {
      action: 'webhook', outcome: NOTIFY_OUTCOME[event.status], orderId: event.orderId,
      bookingId: outcome.booking.id, reference: outcome.booking.reference, channel: outcome.booking.channel,
      reason: event.status === 'charged_back' ? 'charged_back' : outcome.kind === 'stale_attempt' ? 'stale_attempt' : null,
    });

    if (outcome.kind === 'duplicate') {
      return c.json({ ok: true, idempotent: true }, 200);
    }

    if (outcome.kind === 'reversal') {
      void alerts.send({
        severity: 'critical',
        kind: 'payment_reversed',
        title: `Payment reversed for order ${event.orderId}`,
        body: `A non-success PayHere notification (cancel/chargeback) arrived for order ${event.orderId}, which was already settled. The booking may still read PAID — investigate and reconcile the refund/chargeback.`,
        dedupeKey: event.orderId,
      });
      return c.json({ ok: true, reversed: true }, 200);
    }

    // A decline from an EARLIER attempt on an order a later attempt already paid (one order can
    // carry several attempts). Recorded as evidence by the settlement; not a reversal, no page.
    if (outcome.kind === 'stale_attempt') {
      return c.json({ ok: true, staleAttempt: true }, 200);
    }

    if (outcome.kind === 'failed') {
      // Immediate best-effort nudge so the customer can retry. Idempotent (once per booking),
      // and never fails the webhook — PayHere must not retry over a mail hiccup.
      const failed = outcome.booking;
      if (failed.status === 'payment_pending' && !(await notificationLog?.wasSent(failed.id, 'payment_failed'))) {
        try {
          await sendPaymentFailed(failed, email, { resume: manageUrl(failed, baseUrl, linkSecret) });
          await notificationLog?.markSent(failed.id, 'payment_failed');
        } catch (err) {
          console.error(`payment-failed email failed for ${failed.reference}:`, err);
        }
      }
      // The team's rescue (owner, 2026-09-26): a one-tap WhatsApp message to the customer,
      // pre-filled with the same booking link. Card DECLINES only: a cancel (-1) is the customer
      // choosing not to pay. Once per booking: PayHere's later declines on the same order are
      // payment_id 0 duplicates (#792) and never reach here, and the dedupe key is the booking.
      // Last and best-effort, like the "Paid:" mail: it must cost neither the customer's email
      // nor the webhook.
      if (event.status === 'failed' && failed.status === 'payment_pending') {
        try {
          await alerts.send({
            severity: 'warning',
            kind: 'payment_rescue',
            title: `Rescue: ${failed.input.customer.firstName} couldn’t pay ${failed.reference}`,
            body: `PayHere declined the card on ${failed.reference}. Message the customer on WhatsApp with their booking link (check it is still unpaid first).`,
            email: teamRescueEmail(failed, manageUrl(failed, baseUrl, linkSecret), deps.opsBaseUrl ?? ''),
            dedupeKey: failed.id,
          });
        } catch (err) {
          console.error(`rescue alert failed for ${failed.reference}:`, err);
        }
      }
      return c.json({ ok: true, status: 'failed' }, 200);
    }

    // Captured twice: another payment on this booking had already settled (ops took the cash and
    // marked it paid while this notify was in flight). Both amounts are real, so the refundable
    // ceiling legitimately sums them — which is exactly why this can't be quiet: whoever refunds
    // must know there are two captures to give back, not one. No customer email: the booking was
    // already settled by the first capture, and a second "confirmed" would only confuse.
    if (outcome.kind === 'double_capture' && outcome.firstCaptureTxnId) {
      // Same order captured twice (PayHere does not enforce order_id uniqueness). Our payment row
      // keeps the FIRST capture; the second is only in payment_events, so the refund tool's
      // ceiling does not include it — say exactly which one has to be refunded by hand.
      void alerts.send({
        severity: 'critical',
        kind: 'payment_double_capture',
        title: `DOUBLE CAPTURE on booking ${outcome.booking.reference}`,
        body: `Order ${event.orderId} was captured TWICE on PayHere: payment ${outcome.firstCaptureTxnId} (recorded) and payment ${event.providerTxnId} (${event.currency} ${event.amountCents / 100}). The customer has been charged twice. Refund payment ${event.providerTxnId} in the PayHere portal — our refund tool only sees ${outcome.firstCaptureTxnId}.`,
        dedupeKey: `${event.orderId}:${event.providerTxnId}`,
      });
      return c.json({ ok: true, doubleCapture: true }, 200);
    }
    if (outcome.kind === 'double_capture') {
      void alerts.send({
        severity: 'critical',
        kind: 'payment_double_capture',
        title: `DOUBLE CAPTURE on booking ${outcome.booking.reference}`,
        body: `Order ${event.orderId} captured ${event.currency} ${event.amountCents / 100}, but another payment on booking ${outcome.booking.reference} had ALREADY settled. The customer has been charged twice (or a cash settlement was double-collected) — refund one capture. Until then the refundable total is the SUM of both.`,
        dedupeKey: event.orderId,
      });
      return c.json({ ok: true, doubleCapture: true }, 200);
    }

    if (outcome.kind === 'settled') {
      const paid = outcome.booking;
      // Money landed — claim the quote behind this booking (pay-link flow). Best-effort
      // inside claimWonQuote itself: a bookkeeping failure never 500s the webhook.
      await claimWonQuote(paid.id, deps);
      // Best-effort: the booking is already paid, so a concierge-task hiccup must NOT 500 the
      // webhook (PayHere would retry, hit the idempotent return, and skip the task forever).
      try {
        await conciergeTasks.create({ bookingId: paid.id, type: 'confirm_pickup' });
      } catch (err) {
        console.error(`concierge task failed for ${paid.reference}:`, err);
        void alerts.send({
          severity: 'critical',
          kind: 'concierge_task_failed',
          title: `Confirm-pickup task failed for ${paid.reference}`,
          body: `Booking ${paid.reference} is PAID but the confirm_pickup ops task wasn't created. Error: ${err instanceof Error ? err.message : String(err)}`,
          dedupeKey: paid.reference,
        });
      }
      // Confirmation email is best-effort: the booking is already paid, so a mail
      // provider hiccup must NOT fail the webhook (which would make PayHere retry).
      try {
        // A partial deposit (amountDueNow < total) gets the deposit-received email instead of
        // the full confirmation. Dormant today — the engine charges the full amount for every
        // public booking — but wired so reintroducing deposits needs no webhook change.
        if (paid.amountDueNow != null && paid.amountDueNow < paid.total) {
          await sendDepositReceived(paid, email, { manage: manageUrl(paid, baseUrl, linkSecret) });
          await notificationLog?.markSent(paid.id, 'deposit_received');
        } else {
          // Partial pay link (spec 2026-08-04): if this booking was sold as part of a quote,
          // say so in the email — the itinerary alone can't (its flat stop list renders a gap
          // as a driven leg, docs/known-bugs.md 2026-07-30). Best-effort like everything here.
          const srcQuote = await deps.quotes?.findByConvertedBookingId(paid.id).catch(() => null);
          const sel = srcQuote?.payLinkSelection;
          const legCount = ((srcQuote?.request as { engine?: { legs?: unknown[] } } | null)?.engine?.legs ?? []).length;
          const outcome = await sendBookingConfirmation(paid, email, {
            manage: manageUrl(paid, baseUrl, linkSecret),
            ...(sel && legCount ? { coverage: { soldLegs: sel.legIndexes.length, totalLegs: legCount } } : {}),
          });
          // M17: log the send so the watchdog can spot paid-without-confirmation bookings.
          // Only when it actually left. A suppressed message (NOTIFICATIONS_ENABLED off, or an
          // allowlist still in place) reached nobody, and recording it here would assert the
          // opposite — and this row is the very thing the watchdog checks before staying quiet
          // (audit 2026-09-22, finding 2). Leave it unwritten and let the alarm do its job.
          if (wasDelivered(outcome)) await notificationLog?.markSent(paid.id, 'confirmation');
        }
        // Paid but the date/time is still flexible → a follow-up nudge that we'll
        // confirm the exact pickup on WhatsApp. Best-effort; never fails the webhook.
        if (needsDetails(paid)) {
          try {
            await sendDetailsNeeded(paid, email, { manage: manageUrl(paid, baseUrl, linkSecret) });
          } catch (err) {
            console.error(`details-needed email failed for ${paid.reference}:`, err);
          }
        }
      } catch (err) {
        console.error(`confirmation email failed for ${paid.reference}:`, err);
        void alerts.send({
          severity: 'critical',
          kind: 'confirmation_email_failed',
          title: `Confirmation email failed for ${paid.reference}`,
          body: `Booking ${paid.reference} is PAID but the customer got no confirmation. Error: ${err instanceof Error ? err.message : String(err)}`,
          dedupeKey: paid.reference,
        });
      }
      // Tell the team money landed. Until now NOTHING did: no email, no Slack, no Sentry event
      // — the only signals were a once-daily aggregate digest and a watchdog whose 15-minute
      // cron was never scheduled. A real $39 payment settled on 2026-08-02 and the team found
      // out because the owner went looking.
      //
      // Deliberately LAST and best-effort: the customer's confirmation comes first, and a
      // failure here must cost neither their email nor the webhook (PayHere would retry, hit
      // the idempotent return, and skip everything downstream forever). Severity 'info', so it
      // does not read as an incident; dedupeKey is the reference, so a retry cannot re-notify.
      try {
        await alerts.send({
          severity: 'info',
          kind: 'booking_paid',
          title: `Paid: ${paid.reference} — ${fmtMoney(paid.total, paid.currency)}`,
          body: teamPaidBody(paid),
          email: teamPaidEmail(paid, deps.opsBaseUrl ?? ''),
          dedupeKey: paid.reference,
        });
      } catch (err) {
        console.error(`team paid-notification failed for ${paid.reference}:`, err);
      }
      // The customer's earlier failed attempts at this same trip are leftovers now (Lea:
      // CH-Y5RXW declined at 3-D Secure, CH-L72HX paid 20 min later) — close them quietly.
      // After everything the paid booking needs, and NOT awaited: housekeeping on OTHER bookings
      // must neither fail nor delay this 200 (PayHere would retry, hit the idempotent return and
      // skip nothing — but a slow lookup still holds the notify open). A replay never gets here.
      if (deps.duplicates) {
        void closeOlderDuplicates(paid, { ...deps.duplicates, alerts }).catch((err) => {
          console.error(`duplicate close after ${paid.reference} failed:`, err);
        });
      }
    } else {
      // Money captured, but the booking is NOT awaiting payment (cancelled while the customer
      // sat on the PayHere page, already-progressed, or missing). It will never be marked paid
      // and no confirmation goes out — surface it loudly instead of returning ok silently.
      void alerts.send({
        severity: 'critical',
        kind: 'paid_in_unexpected_status',
        title: `Payment settled for order ${event.orderId} in an unexpected state`,
        body: `Payment for ${event.orderId} succeeded, but its booking is in status '${outcome.booking.status}' (not payment_pending). Money was captured with no paid-transition and no confirmation — investigate and reconcile.`,
        dedupeKey: event.orderId,
      });
    }
    return c.json({ ok: true }, 200);
  });

  // M17 — Resend deliverability webhook (svix-signed). Alerts on bounces/complaints so a
  // customer silently not receiving booking email is no longer invisible. Enabled only
  // when the secret is configured; otherwise the route does not exist (404).
  r.post('/resend', async (c) => {
    const secret = deps.resendWebhookSecret;
    if (!secret) return c.notFound();

    const id = c.req.header('svix-id') ?? '';
    const timestamp = c.req.header('svix-timestamp') ?? '';
    const sigHeader = c.req.header('svix-signature') ?? '';
    const raw = await c.req.text();

    // Reject stale/replayed deliveries (>5 min skew).
    const ts = Number(timestamp);
    if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    // svix scheme: HMAC-SHA256 over "id.timestamp.body" with the base64 key after "whsec_",
    // matched (constant-time) against any "v1,<base64>" entry in the signature header.
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest();
    const match = sigHeader.split(' ').some((part) => {
      const [version, sig] = part.split(',');
      if (version !== 'v1' || !sig) return false;
      const given = Buffer.from(sig, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!match) return c.json({ error: 'invalid_signature' }, 401);

    let event: { type?: string; data?: { to?: string[] | string; subject?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      const to = Array.isArray(event.data?.to) ? event.data.to.join(', ') : (event.data?.to ?? 'unknown');
      void alerts.send({
        severity: 'warning',
        kind: 'email_bounce',
        title: `Email ${event.type === 'email.bounced' ? 'bounced' : 'flagged as spam'}: ${to}`,
        body: `to: ${to}\nsubject: ${event.data?.subject ?? '?'}\nevent: ${event.type}`,
        dedupeKey: to,
      });
    }
    return c.body(null, 204);
  });

  return r;
}
