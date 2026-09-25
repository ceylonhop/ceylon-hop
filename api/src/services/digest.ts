import type { BookingRepo } from '../db/bookingRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import type { BookingCheckoutEventRepo } from '../db/bookingCheckoutEventRepo';
import { opsEmailShell, detailTable, money } from './opsEmail';
import { WATCHDOG_TICK, agoText } from './watchdog';
import { isTeamEmail } from './testBookings';

// M17 daily ops digest — one compact founder email per day riding the notifications
// tick: what the business did in the last 24 h and whether the watchdog barked. Pure
// reads; the caller treats the whole thing as best-effort.

const ALERT_LABELS: Record<string, string> = {
  watchdog_stuck_pending: 'Payments stuck in pending',
  watchdog_paid_unconfirmed: 'Paid, no confirmation sent',
  watchdog_stale: 'Watchdog not running',
  payment_failed: 'Payment failed',
};
// Ledger rows that are bookkeeping, not alerts anyone received.
const NOT_ALERTS = new Set(['ops_digest', WATCHDOG_TICK.kind]);
const alertLabel = (kind: string): string => ALERT_LABELS[kind] ?? kind;
// Payments early warning: at least this many checkouts, and fewer than this share paid.
const PAY_WARN_MIN_STARTED = 3;
const PAY_WARN_MIN_PAID_SHARE = 0.6;

export async function buildDigest(
  now: Date,
  deps: {
    bookings: BookingRepo;
    alertLog?: AlertLogRepo;
    quotes?: QuoteRepo;
    opsBaseUrl?: string;
    teamEmails?: ReadonlySet<string>;
    checkoutEvents?: Pick<BookingCheckoutEventRepo, 'summarySince'>;
  },
): Promise<{ subject: string; text: string; html: string }> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const all = await deps.bookings.list();
  const recent = all.filter((b) => Date.parse(b.createdAt) >= since.getTime());
  // Status counts leave the team's own test bookings out (config.TEAM_EMAILS): every "Payment
  // pending" in the August digests was an owner test. The 24h created/value lines are untouched.
  const team = deps.teamEmails ?? new Set<string>();
  const byStatus = (s: string) => all.filter((b) => b.status === s && !isTeamEmail(b.input.customer.email, team)).length;
  // USD-only assumption: bookings are USD today, so we sum minor units and label them $.
  // Revisit if a non-USD booking currency is ever introduced (would need per-currency grouping).
  const valueBooked = recent.reduce((sum, b) => sum + b.total, 0);

  const rows: [string, string][] = [
    ['Bookings created (24h)', String(recent.length)],
    ['Value booked (24h)', money(valueBooked, 'USD')],
    ['Now paid', String(byStatus('paid'))],
    ['Confirmed', String(byStatus('confirmed'))],
    ['Payment pending', String(byStatus('payment_pending'))],
  ];

  if (deps.quotes) {
    // QuoteSummary.createdAt is a Date (see db/quoteRepo.ts).
    const q = await deps.quotes.list({ channel: 'ops' });
    // Exclude unpriced shells (spec 2026-07-29) — a "+ New quote" click shouldn't inflate this
    // for the 24h it takes the sweep to soft-delete it. QuoteSummary.unpriced is already computed
    // per row by list(); read it rather than re-deriving the shell marker here.
    const qRecent = q.filter((r) => !r.unpriced && r.createdAt.getTime() >= since.getTime());
    const qByStatus = (s: string) => q.filter((r) => r.status === s).length;
    rows.push(['Quotes created (24h)', String(qRecent.length)]);
    rows.push(['Open pipeline', `ready: ${qByStatus('ready')} · sent: ${qByStatus('sent')}`]);
  }

  // The watchdog's heartbeat (CH-V43ZU): "did the monitor run?" is a fact the founder
  // should see every day, whether or not it barked.
  if (deps.alertLog) {
    rows.push(['Watchdog last ran', agoText(now, await deps.alertLog.lastSentAt(WATCHDOG_TICK.kind, WATCHDOG_TICK.key))]);
  }

  const alertCounts = deps.alertLog ? await deps.alertLog.countsSince(since) : {};
  const alertRows: [string, string][] = Object.entries(alertCounts)
    .filter(([kind]) => !NOT_ALERTS.has(kind))
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => [alertLabel(kind), String(n)]);

  // Payments (24h), from the checkout attempt log (migration 0055): the founder's early warning
  // that website payments are failing, without running SQL. Team test bookings are left out.
  let payLine: string | null = null;
  let payWarn: string | null = null;
  if (deps.checkoutEvents) {
    const teamIds = all.filter((b) => isTeamEmail(b.input.customer.email, team)).map((b) => b.id);
    const p = await deps.checkoutEvents.summarySince(since, { excludeBookingIds: teamIds });
    payLine =
      `Checkouts started: ${p.started} · paid ${p.paid} · declined ${p.declined} · ` +
      `cancelled at PayHere ${p.cancelledAtGateway} · no answer ${p.abandoned} · booking errors ${p.createRefused}`;
    if (p.started >= PAY_WARN_MIN_STARTED && p.paid / p.started < PAY_WARN_MIN_PAID_SHARE) {
      payWarn = `⚠ Only ${Math.round((p.paid / p.started) * 100)}% of checkouts paid in the last 24h — check booking_checkout_event`;
    }
  }

  const link = (deps.opsBaseUrl || '').trim().replace(/\/+$/, '');
  const textLines = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    ...(payLine ? ['', `Payments (24h):\n  ${payLine}`, ...(payWarn ? [`  ${payWarn}`] : [])] : []),
    '',
    alertRows.length ? `Alerts fired (24h):\n${alertRows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}` : 'Alerts fired (24h): none',
    ...(link ? ['', `Dashboard: ${link}/ops`] : []),
  ];
  const html = [
    '<h2 style="font-size:18px;margin:0 0 12px">Daily ops digest</h2>',
    detailTable(rows),
    payLine
      ? `<h3 style="font-size:14px;margin:0 0 8px">Payments (24h)</h3><p style="font-size:14px;margin:0 0 12px">${payLine}</p>` +
        (payWarn ? `<p style="font-size:14px;margin:0 0 12px;color:#b91c1c;font-weight:600">${payWarn}</p>` : '')
      : '',
    alertRows.length ? `<h3 style="font-size:14px;margin:0 0 8px">Alerts fired (24h)</h3>${detailTable(alertRows)}` : '<p style="font-size:14px;color:#6b7280">No alerts fired in the last 24h.</p>',
    link ? `<p style="margin:16px 0 0"><a href="${link}/ops" style="color:#24758A">Open the ops dashboard</a></p>` : '',
  ].join('');

  const wrapped = opsEmailShell(html, textLines.join('\n'));
  return { subject: `Ceylon Hop ops digest — ${now.toISOString().slice(0, 10)}`, text: wrapped.text, html: wrapped.html };
}
