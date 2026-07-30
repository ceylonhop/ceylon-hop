import type { QuoteRepo } from '../db/quoteRepo';

// How long an unpriced shell may sit untouched before the sweep soft-deletes it (owner
// 2026-07-29). "+ New quote" creates a real row so the ticket can be assigned on the call, which
// means an abandoned click leaves a row behind; this is what keeps the queue bounded. Anchored on
// updatedAt, not createdAt, so a shell someone actually touched gets a fresh window. 24h is also
// the floor set by the driver: the sweep rides the DAILY cron tick, so a shorter window could not
// be enforced without a new schedule.
export const ABANDONED_DRAFT_TTL_MS = 24 * 3600 * 1000;

// Soft-delete ops draft shells nobody finished. Pure over (now, repos) like the other scheduler
// sweeps so it's deterministic in tests; the cron tick drives it with the real clock. Naturally
// idempotent (a deleted row no longer appears in list()) and per-row best-effort — one bad row
// must not strand the rest of the sweep. Soft delete only: the row stays in the table, so a wrong
// call is recoverable, matching the existing soft-delete contract.
export async function sweepAbandonedDrafts(
  now: Date,
  deps: { quotes: QuoteRepo },
): Promise<{ swept: number }> {
  const { quotes } = deps;
  let swept = 0;
  for (const summary of await quotes.list({ channel: 'ops', status: 'draft' })) {
    if (!summary.unpriced) continue; // priced work is never swept, at any age
    const q = await quotes.get(summary.id);
    if (!q) continue;
    if (now.getTime() - q.updatedAt.getTime() < ABANDONED_DRAFT_TTL_MS) continue;
    try {
      await quotes.softDelete(q.id, 'system:draft-cleanup');
      swept++;
    } catch (err) {
      console.error(`abandoned-draft sweep failed for ${q.reference}:`, err);
    }
  }
  return { swept };
}
