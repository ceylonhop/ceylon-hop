import type { BookingRepo } from '../db/bookingRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';
import type { QuoteRepo } from '../db/quoteRepo';
import { opsEmailShell, detailTable, money } from './opsEmail';

// M17 daily ops digest — one compact founder email per day riding the notifications
// tick: what the business did in the last 24 h and whether the watchdog barked. Pure
// reads; the caller treats the whole thing as best-effort.

const ALERT_LABELS: Record<string, string> = {
  watchdog_stuck_pending: 'Payments stuck in pending',
  watchdog_paid_unconfirmed: 'Paid, no confirmation sent',
  payment_failed: 'Payment failed',
};
const alertLabel = (kind: string): string => ALERT_LABELS[kind] ?? kind;

export async function buildDigest(
  now: Date,
  deps: { bookings: BookingRepo; alertLog?: AlertLogRepo; quotes?: QuoteRepo; opsBaseUrl?: string },
): Promise<{ subject: string; text: string; html: string }> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const all = await deps.bookings.list();
  const recent = all.filter((b) => Date.parse(b.createdAt) >= since.getTime());
  const byStatus = (s: string) => all.filter((b) => b.status === s).length;
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
    const qRecent = q.filter((r) => r.createdAt.getTime() >= since.getTime());
    const qByStatus = (s: string) => q.filter((r) => r.status === s).length;
    rows.push(['Quotes created (24h)', String(qRecent.length)]);
    rows.push(['Open pipeline', `ready: ${qByStatus('ready')} · sent: ${qByStatus('sent')}`]);
  }

  const alertCounts = deps.alertLog ? await deps.alertLog.countsSince(since) : {};
  const alertRows: [string, string][] = Object.entries(alertCounts)
    .filter(([kind]) => kind !== 'ops_digest')
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => [alertLabel(kind), String(n)]);

  const link = (deps.opsBaseUrl || '').trim().replace(/\/+$/, '');
  const textLines = [
    ...rows.map(([k, v]) => `${k}: ${v}`),
    '',
    alertRows.length ? `Alerts fired (24h):\n${alertRows.map(([k, v]) => `  ${k}: ${v}`).join('\n')}` : 'Alerts fired (24h): none',
    ...(link ? ['', `Dashboard: ${link}/ops`] : []),
  ];
  const html = [
    '<h2 style="font-size:18px;margin:0 0 12px">Daily ops digest</h2>',
    detailTable(rows),
    alertRows.length ? `<h3 style="font-size:14px;margin:0 0 8px">Alerts fired (24h)</h3>${detailTable(alertRows)}` : '<p style="font-size:14px;color:#6b7280">No alerts fired in the last 24h.</p>',
    link ? `<p style="margin:16px 0 0"><a href="${link}/ops" style="color:#0a7d6f">Open the ops dashboard</a></p>` : '',
  ].join('');

  const wrapped = opsEmailShell(html, textLines.join('\n'));
  return { subject: `Ceylon Hop ops digest — ${now.toISOString().slice(0, 10)}`, text: wrapped.text, html: wrapped.html };
}
