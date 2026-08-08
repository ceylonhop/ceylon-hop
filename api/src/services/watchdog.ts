import type { BookingRepo } from '../db/bookingRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RefundRepo } from '../db/refundRepo';
import type { AlertAdapter } from '../adapters/alerts';
import type { EmailAdapter } from '../adapters/email';
import type { SendBudget } from './sendBudget';
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
// A refund call that has not resolved in this long did not resolve. The row is left in
// api_processing on purpose (PayHere's Refund API has no idempotency key, so it can never be
// retried), which means the ONLY way it clears is a human reading PayHere's dashboard — so
// this alert is the entire mechanism by which anyone finds out. It re-raises every sweep,
// deduped per refund, until someone resolves the row.
const STUCK_REFUND_MS = 15 * 60_000;

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
    // Optional like the email deps above so existing callers/tests keep working. Without it the
    // out-of-band exemption below can't be evaluated and every manually settled booking alerts;
    // the one production mount (POST /admin/jobs/watchdog) always passes it.
    payments?: PaymentRepo;
    // Optional like the rest; without it stuck refunds simply are not swept.
    refunds?: RefundRepo;
    // Blast-radius cap (R1) — bounds the CUSTOMER recovery emails only. Ops alerts below
    // are never capped: they are how a human finds out anything is wrong, so throttling
    // them would hide the very burst this budget exists to surface.
    budget?: SendBudget;
  },
): Promise<{
  stuckPending: number;
  paidUnconfirmed: number;
  recoveryEmails: number;
  stuckRefunds: number;
}> {
  const { bookings, log, alerts, email, baseUrl, linkSecret, payments, refunds, budget } = deps;

  const pending = await bookings.list({ status: 'payment_pending' });
  const stuck: typeof pending = [];
  for (const b of pending) {
    const age = now.getTime() - Date.parse(b.createdAt);
    if (age < STUCK_PENDING_MS || age >= STUCK_PENDING_MAX_MS) continue;
    // Ops-booked bookings (channel 'whatsapp') were exempt wholesale when every one of
    // them was settled by hand. Pay links (2026-07-31) changed that: once a customer has
    // STARTED a gateway checkout on one, an abandoned payment is a real event again — the
    // same abandoned cart the website flow gets chased for. So the exemption now applies
    // only while no gateway payment is pending; hand-settled bookings never have one.
    if (b.channel === 'whatsapp') {
      const gatewayPending = payments
        ? (await payments.findByBookingId(b.id)).some(
            (p) => p.status === 'pending' && (p.provider === 'payhere' || p.provider === 'fake'),
          )
        : false;
      if (!gatewayPending) continue;
    }
    stuck.push(b);
  }
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
      // Over the cap: the ops alert above still fired, so nothing is lost — only the
      // customer email waits for the next run. Not ledgered, so that run still sends it.
      if (budget && !budget.tryClaim()) {
        budget.suppress('payment_recovery', b.reference);
        continue;
      }
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
    // Money that arrived out-of-band (cash/bank recorded by ops via mark-paid) is NOT a silent
    // failure — that route deliberately sends no confirmation email (owner 2026-07-30), so the
    // missing log entry is the expected state, not a symptom. Same spirit as the channel
    // 'whatsapp' exemption above. It matters more here because nothing ever clears the
    // condition: a paid booking stays 'paid' (the pipeline advances ride_ops.fulfilmentStatus,
    // not bookings.status), so without this a cash booking taken six weeks out would page the
    // founder every sweep until departure and drown the alerts that mean something.
    // Deliberately NOT keyed on the notification log: writing a fake 'confirmation' entry would
    // assert an email that never went out, and the same key gates the real send later.
    if (payments && (await payments.hasManualSettlement(b.id))) continue;
    paidUnconfirmed += 1;
    await alerts.send({
      severity: 'critical',
      kind: 'watchdog_paid_unconfirmed',
      title: `Paid booking ${b.reference} has no confirmation email`,
      body: `Booking ${b.reference} is PAID but no confirmation send is recorded — the customer may not know their booking is confirmed. Resend it manually.`,
      dedupeKey: b.id,
    });
  }

  // Refunds that were sent to the gateway and never came back. Money may have left the account
  // with nothing in our ledger saying so, and no automatic process will ever resolve it.
  let stuckRefunds = 0;
  if (refunds) {
    for (const refund of await refunds.listStuckApi(new Date(now.getTime() - STUCK_REFUND_MS))) {
      stuckRefunds += 1;
      const booking = await bookings.get(refund.bookingId);
      await alerts.send({
        severity: 'critical',
        kind: 'refund_stuck_processing',
        title: `Refund still unresolved for ${booking?.reference ?? refund.bookingId}`,
        body:
          `A refund of ${refund.amountCents / 100} ${refund.currency} has been mid-call since ` +
          `${refund.apiAttemptedAt?.toISOString() ?? 'unknown'} and never resolved. The money MAY ` +
          `have moved.\n\nDo NOT retry — this API has no idempotency key. Open PayHere > Payments, ` +
          `find the payment for booking ${booking?.reference ?? refund.bookingId}, and either confirm ` +
          `this refund with its reference or, if no refund exists, cancel and re-request.`,
        dedupeKey: refund.id,
      });
    }
  }

  return { stuckPending: stuck.length, paidUnconfirmed, recoveryEmails, stuckRefunds };
}
