import { Hono } from 'hono';
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
import { sendBookingConfirmation, sendDetailsNeeded, sendPaymentFailed, sendDepositReceived, needsDetails, manageUrl, routeText } from '../services/notifications';
import { money as fmtMoney } from '../services/opsEmail';
import type { Booking } from '../db/bookingRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { claimWonQuote } from '../services/quoteOutcome';

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
    `${c.firstName} ${c.lastName} · ${c.email} · ${c.whatsapp}`,
    `${fmtMoney(b.total, b.currency)} · booked via ${b.channel}`,
    `Reference ${b.reference}`,
  ].join('\n');
}

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
}) {
  const { settlements, adapter, email, conciergeTasks, notificationLog, baseUrl, linkSecret } = deps;
  const alerts: AlertAdapter = deps.alerts ?? { send: async () => {} };
  const r = new Hono();

  // 5.3 — payment webhook. Verifies signature, reconciles the amount, marks the payment
  // succeeded and the booking paid — idempotently — then sends the confirmation (5.4).
  // M17: the silent failure paths now raise throttled ops alerts.
  r.post('/payments', async (c) => {
    const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
    const isExpectedContentType = adapter.provider !== 'payhere' || contentType === 'application/x-www-form-urlencoded';
    const rawBody = await c.req.text();
    const event = isExpectedContentType ? adapter.parseWebhook(rawBody) : null;
    if (!event) {
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
      return c.json({ ok: true, status: 'failed' }, 200);
    }

    // Captured twice: another payment on this booking had already settled (ops took the cash and
    // marked it paid while this notify was in flight). Both amounts are real, so the refundable
    // ceiling legitimately sums them — which is exactly why this can't be quiet: whoever refunds
    // must know there are two captures to give back, not one. No customer email: the booking was
    // already settled by the first capture, and a second "confirmed" would only confuse.
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
          await sendBookingConfirmation(paid, email, { manage: manageUrl(paid, baseUrl, linkSecret) });
          // M17: log the send so the watchdog can spot paid-without-confirmation bookings.
          await notificationLog?.markSent(paid.id, 'confirmation');
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
          dedupeKey: paid.reference,
        });
      } catch (err) {
        console.error(`team paid-notification failed for ${paid.reference}:`, err);
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
