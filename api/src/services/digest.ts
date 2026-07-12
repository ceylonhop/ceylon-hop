import type { BookingRepo } from '../db/bookingRepo';
import type { AlertLogRepo } from '../db/alertLogRepo';

// M17 daily ops digest — one compact founder email per day riding the notifications
// tick: what the business did in the last 24 h and whether the watchdog barked. Pure
// reads; the caller treats the whole thing as best-effort.

export async function buildDigest(
  now: Date,
  deps: { bookings: BookingRepo; alertLog?: AlertLogRepo },
): Promise<{ subject: string; text: string; html: string }> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const all = await deps.bookings.list();
  const recent = all.filter((b) => Date.parse(b.createdAt) >= since.getTime());
  const byStatus = (s: string) => all.filter((b) => b.status === s).length;

  const alertCounts = deps.alertLog ? await deps.alertLog.countsSince(since) : {};
  const alertLines = Object.entries(alertCounts)
    // 'ops_digest' is the digest's own once-per-day guard row (BI4), not a real alert — hide it.
    .filter(([kind]) => kind !== 'ops_digest')
    .sort(([, a], [, b]) => b - a)
    .map(([kind, n]) => `  ${kind}: ${n}`);

  const lines = [
    `Bookings created (24h): ${recent.length}`,
    `Now paid: ${byStatus('paid')} · confirmed: ${byStatus('confirmed')} · payment_pending: ${byStatus('payment_pending')}`,
    '',
    alertLines.length ? `Alerts fired (24h):\n${alertLines.join('\n')}` : 'Alerts fired (24h): none',
  ];
  const text = lines.join('\n');
  const day = now.toISOString().slice(0, 10);

  return {
    subject: `Ceylon Hop ops digest — ${day}`,
    text,
    html: `<pre style="font:14px/1.5 monospace">${text.replace(/</g, '&lt;')}</pre>`,
  };
}
