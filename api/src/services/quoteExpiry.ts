import type { QuoteRepo } from '../db/quoteRepo';

// How long an ops quote may sit in 'sent' before the sweep closes it as 'expired' (owner
// 2026-07-17). Anchored on sentAt — the customer's clock — not createdAt. This is a separate
// idle timer, NOT the rate lock: rate lock time-boxes web quotes only (7 days from generation);
// ops quotes lock at approval with rate_locked_until = null, so they carry no rate-lock expiry.
// Web quotes are deliberately out of scope here — their pricing already rolls to the current
// card after the lock via rateCardFor(); see api/src/quote/rateLock.ts.
export const SENT_QUOTE_TTL_MS = 30 * 24 * 3600 * 1000; // 30 days

// Close ops quotes that have sat unanswered in 'sent' past the TTL. Pure over (now, repos) like
// the other scheduler sweeps so it's deterministic in tests; the cron tick drives it with the
// real clock. Naturally idempotent (an expired quote no longer matches status='sent') and
// per-row best-effort — one bad row must not strand the rest of the sweep.
export async function expireStaleQuotes(
  now: Date,
  deps: { quotes: QuoteRepo },
): Promise<{ expired: number }> {
  const { quotes } = deps;
  let expired = 0;
  for (const summary of await quotes.list({ channel: 'ops', status: 'sent' })) {
    const q = await quotes.get(summary.id);
    // sentAt is the idle anchor; without it we can't judge age, so leave the quote alone.
    if (!q || !q.sentAt) continue;
    if (now.getTime() - q.sentAt.getTime() < SENT_QUOTE_TTL_MS) continue;
    try {
      await quotes.patch(q.id, { status: 'expired' });
      expired++;
    } catch (err) {
      console.error(`quote expiry failed for ${q.reference}:`, err);
    }
  }
  return { expired };
}
