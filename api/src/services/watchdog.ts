import type { BookingRepo } from '../db/bookingRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { RefundRepo } from '../db/refundRepo';
import type { AlertAdapter } from '../adapters/alerts';
import type { EmailAdapter } from '../adapters/email';
import { hasDeliverableAddress, wasDelivered } from '../adapters/email';
import type { AlertLogRepo } from '../db/alertLogRepo';
import type { Booking } from '../db/bookingRepo';
import type { Payment } from '../db/paymentRepo';
import type { SendBudget } from './sendBudget';
import { sendPaymentIncomplete, manageUrl, routeText, travelWhenText } from './notifications';
import { bookingDeepLink } from './opsNotifications';
import { isTeamEmail } from './testBookings';

// Heartbeat row in the alert ledger (CH-V43ZU, 2026-09-24). Written with a zero cooldown at
// the end of every sweep, so its last_sent_at is simply "when the watchdog last ran". Nothing
// else in this repo knows the cron's schedule — the daily tick reads this row to find out
// whether the cron is alive, and the digest shows it.
export const WATCHDOG_TICK = { kind: 'watchdog_tick', key: 'last' } as const;
// The cron is meant to fire every ~15 min; an hour of silence is four missed ticks.
// Exported for /health/deep, which reports the same staleness to an uptime monitor.
export const WATCHDOG_STALE_MS = 60 * 60_000;

export function agoText(now: Date, at: Date | null): string {
  if (!at) return 'never';
  return `${Math.round((now.getTime() - at.getTime()) / 60_000)} min ago (${at.toISOString()})`;
}

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
    // Heartbeat ledger (see WATCHDOG_TICK). Optional so existing callers/tests keep working;
    // without it the sweep leaves no footprint and the liveness check has nothing to read.
    alertLog?: AlertLogRepo;
    // Deep link in the stuck-pending alert. '' without OPS_BASE_URL, as everywhere else.
    opsBaseUrl?: string;
    // The team's own addresses (config.TEAM_EMAILS, services/testBookings.ts). A stuck booking
    // made under one is a test checkout: no recovery email, no page. Optional; empty = no-op.
    teamEmails?: ReadonlySet<string>;
  },
): Promise<{
  stuckPending: number;
  paidUnconfirmed: number;
  recoveryEmails: number;
  stuckRefunds: number;
}> {
  const { bookings, log, alerts, email, baseUrl, linkSecret, payments, refunds, budget, alertLog, opsBaseUrl } = deps;
  const teamEmails = deps.teamEmails ?? new Set<string>();

  const pending = await bookings.list({ status: 'payment_pending' });
  const stuck: typeof pending = [];
  for (const b of pending) {
    const age = now.getTime() - Date.parse(b.createdAt);
    if (age < STUCK_PENDING_MS || age >= STUCK_PENDING_MAX_MS) continue;
    // The owner's and team's own test bookings (#764): the ops queue and the digest already leave
    // them out; chasing them mailed the owner and paged the founder about their own test.
    if (isTeamEmail(b.input.customer.email, teamEmails)) continue;
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
    // One-shot customer recovery email. Best-effort: a mail hiccup must not abort the
    // sweep (the ops alert below fires regardless). Idempotent via notification_log.
    // Claim before sending (see NotificationLogRepo.claim) — the ~15-min cron can overlap
    // a manual sweep. Every path that does not send hands the claim back.
    // Runs BEFORE the alert so the alert can say what became of it (CH-V43ZU).
    let recovery: string;
    if (!(email && baseUrl && linkSecret)) {
      recovery = 'not configured on this deployment';
    } else if (!hasDeliverableAddress(b.input.customer.email)) {
      // A fact about the customer, not a failure: nothing to send, so nothing to claim,
      // count or retry — and no ledger row asserting a send that never happened.
      recovery = 'none — the customer has no email address';
    } else if (!(await log.claim(b.id, 'payment_recovery'))) {
      recovery = 'already sent (an earlier sweep, or one running right now)';
    } else if (budget && !budget.tryClaim()) {
      // Over the cap: the ops alert below still fires, so nothing is lost — only the
      // customer email waits for the next run.
      await log.release(b.id, 'payment_recovery');
      budget.suppress('payment_recovery', b.reference);
      recovery = 'held back by the burst cap — the next sweep retries';
    } else {
      try {
        const outcome = await sendPaymentIncomplete(b, email, { resume: manageUrl(b, baseUrl, linkSecret) });
        if (wasDelivered(outcome)) {
          recoveryEmails += 1;
          recovery = 'sent just now';
        } else {
          // Suppressed (kill switch / allowlist): nobody was chased, so neither count it nor
          // burn the one-shot claim — or the burst budget — on it. The next sweep tries again.
          budget?.refund();
          await log.release(b.id, 'payment_recovery');
          recovery = `NOT delivered (${outcome && !outcome.delivered ? outcome.reason : 'unknown'}) — the next sweep retries`;
        }
      } catch (err) {
        budget?.refund();
        await log.release(b.id, 'payment_recovery');
        console.error(`payment-recovery email failed for ${b.reference}:`, err);
        recovery = `FAILED to send (${err instanceof Error ? err.message : String(err)}) — the next sweep retries`;
      }
    }
    const gateway = payments ? await payments.findByBookingId(b.id) : null;
    await alerts.send({
      severity: 'critical',
      kind: 'watchdog_stuck_pending',
      title: `Booking ${b.reference} stuck in payment_pending`,
      body: stuckPendingBody(b, now, gateway, recovery, opsBaseUrl ?? ''),
      dedupeKey: b.id,
    });
  }

  const paid = await bookings.list({ status: 'paid' });
  let paidUnconfirmed = 0;
  for (const b of paid) {
    if (now.getTime() - Date.parse(b.createdAt) < UNCONFIRMED_PAID_MS) continue;
    if (await log.wasSent(b.id, 'confirmation')) continue;
    // No address means no confirmation was ever due — a fact about the customer, like the
    // manual-settlement exemption below, not a silent failure. This became load-bearing on
    // 2026-09-22: before then the webhook recorded a send for these bookings even though
    // nothing left, and that false row is what kept this loop quiet. Now that only real
    // sends are recorded, the exemption has to be stated rather than implied — otherwise
    // every WhatsApp-only customer pages the founder on every sweep until they travel.
    if (!hasDeliverableAddress(b.input.customer.email)) continue;
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

  // Footprint. Last, so a sweep that threw halfway leaves no heartbeat — a crashing cron is
  // not a live one, and the liveness alert's wording covers both readings.
  await alertLog?.shouldSend(WATCHDOG_TICK.kind, WATCHDOG_TICK.key, 0, now);

  return { stuckPending: stuck.length, paidUnconfirmed, recoveryEmails, stuckRefunds };
}

// Everything the reader used to have to open three tables for (CH-V43ZU). The one fact
// the gateway line leans on: EVERY verified PayHere notify — success, cancel, decline —
// moves a payment off 'pending' (paymentSettlementRepo), so a payment still pending means
// PayHere has not called back at all, not that it called back with bad news.
function stuckPendingBody(b: Booking, now: Date, gateway: Payment[] | null, recovery: string, opsBaseUrl: string): string {
  const minutes = Math.round((now.getTime() - Date.parse(b.createdAt)) / 60_000);
  const due = b.amountDueNow ?? b.total;
  const gatewayLines =
    gateway === null
      ? ['Gateway: unknown — no payment ledger wired into this sweep']
      : gateway.length === 0
        ? ['Gateway: no gateway payment was ever created — the customer never reached PayHere (checkout was not started).']
        : [
            ...gateway.map((p) => `Gateway: ${p.provider} · ${p.status} · order ${p.orderId} · ${b.currency} ${(p.amount / 100).toFixed(2)}`),
            ...(gateway.some((p) => p.status === 'pending')
              ? ['PayHere has not called back for the pending payment at all (any notify, paid or not, would have moved it off pending): the customer closed the gateway without paying, or the notify never arrived.']
              : []),
          ];
  const link = bookingDeepLink(b.id, opsBaseUrl);
  return [
    `Booking ${b.reference} (${b.currency} ${(due / 100).toFixed(2)}) has been payment_pending for ${minutes} min (since ${b.createdAt}).`,
    `Route: ${routeText(b)} · travels ${travelWhenText(b)}`,
    `Channel: ${b.channel}`,
    ...gatewayLines,
    `Recovery email: ${recovery}`,
    ...(link ? [`Open: ${link}`] : []),
  ].join('\n');
}

// The monitor, monitored. Called from the daily notifications tick — the only other
// scheduled thing — because the watchdog cron lives outside this repo and its silence is
// otherwise indistinguishable from a quiet day.
export async function checkWatchdogLiveness(
  now: Date,
  deps: { alertLog: AlertLogRepo; alerts: AlertAdapter; maxAgeMs?: number },
): Promise<{ stale: boolean; lastRunAt: Date | null }> {
  const lastRunAt = await deps.alertLog.lastSentAt(WATCHDOG_TICK.kind, WATCHDOG_TICK.key);
  const stale = !lastRunAt || now.getTime() - lastRunAt.getTime() > (deps.maxAgeMs ?? WATCHDOG_STALE_MS);
  if (stale) {
    await deps.alerts.send({
      severity: 'warning',
      kind: 'watchdog_stale',
      title: 'Payments watchdog is not running',
      body:
        `The payments watchdog (POST /admin/jobs/watchdog) last completed ${agoText(now, lastRunAt)}; it should run every ~15 min. ` +
        `While it is down, abandoned checkouts, paid-but-unconfirmed bookings and stuck refunds go unseen.\n\n` +
        `Either the external cron is not calling it, or every call is failing before the sweep completes — ` +
        `check the cron service's run history and the API logs for "watchdog_tick".`,
      dedupeKey: 'watchdog',
    });
  }
  return { stale, lastRunAt };
}
