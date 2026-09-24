// "Is this the first time I've seen this key lately?" — an in-process, bounded, expiring set.
//
// Built for GET /bookings/pay-return's attempt-log rows (review of #774, finding 2): the returning
// page polls every 2s for up to a minute, so logging every answer wrote ~30 identical `pending`
// rows per return. Keyed `${bookingId}:${status}`, only the first sighting is logged.
//
// Deliberately in memory. The API runs as a single instance, and losing this on a restart costs
// nothing but one duplicate row per in-flight return — it is a log de-duplicator, never a
// correctness mechanism, so it must not grow a table or a dependency. The TTL lets a genuinely
// later poll (a customer back tomorrow) log again; the cap bounds memory whatever the traffic.
// A Map keeps insertion order, so the first key is always the oldest.
export class SeenOnce {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private readonly max: number;
  private readonly now: () => number;

  constructor(opts: { ttlMs: number; max: number; now?: () => number }) {
    this.ttlMs = opts.ttlMs;
    this.max = opts.max;
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.seen.size;
  }

  /** True the first time `key` is seen within the TTL (and remembers it); false otherwise. */
  first(key: string): boolean {
    const now = this.now();
    const at = this.seen.get(key);
    if (at !== undefined && now - at < this.ttlMs) return false;
    this.seen.delete(key);
    // Drop expired entries from the old end, then make room under the cap.
    for (const [k, t] of this.seen) {
      if (now - t < this.ttlMs && this.seen.size < this.max) break;
      this.seen.delete(k);
    }
    this.seen.set(key, now);
    return true;
  }
}
