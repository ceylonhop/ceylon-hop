import type { UsageCounterRepo } from '../db/usageCounterRepo';

// Count in memory, write coalesced (spec 2026-10-13 §2). bump() is called on hot paths — every
// provider email, every live Google call, every 429 — so it must never await the database. Counts
// accumulate per (UTC day, key) and one timer flushes them as a handful of upserts; a burst of a
// thousand refusals costs one row write per flush. A failed write keeps the pending counts for the
// next flush, and a crash loses at most one flush interval of a gauge — this is a usage signal,
// never a correctness mechanism. The API runs as a single instance, so in-process is enough.

export const utcDay = (d: Date): string => d.toISOString().slice(0, 10);

const DEFAULT_FLUSH_MS = 10_000;

export class UsageMeter {
  private readonly pending = new Map<string, { day: string; key: string; n: number }>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly now: () => Date;
  private readonly flushMs: number;

  constructor(
    private readonly repo: UsageCounterRepo,
    opts: { now?: () => Date; flushMs?: number } = {},
  ) {
    this.now = opts.now ?? (() => new Date());
    this.flushMs = opts.flushMs ?? DEFAULT_FLUSH_MS;
  }

  bump(key: string, n = 1): void {
    const day = utcDay(this.now());
    const id = `${day}|${key}`;
    const row = this.pending.get(id);
    if (row) row.n += n;
    else this.pending.set(id, { day, key, n });
    // flushMs 0 = no timer (tests flush explicitly). unref so a pending flush never holds the
    // process open.
    if (this.flushMs > 0 && !this.timer) {
      this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.flushMs);
      this.timer.unref?.();
    }
  }

  async flush(): Promise<void> {
    if (this.pending.size === 0) return;
    const rows = [...this.pending.values()];
    this.pending.clear();
    for (const row of rows) {
      try {
        await this.repo.add(row.day, row.key, row.n);
      } catch (err) {
        // Put the count back (merging with anything bumped meanwhile) and try again next flush.
        const id = `${row.day}|${row.key}`;
        const again = this.pending.get(id);
        if (again) again.n += row.n;
        else this.pending.set(id, row);
        console.error(`usage counter write failed (${row.key}):`, err instanceof Error ? err.message : String(err));
      }
    }
  }
}
