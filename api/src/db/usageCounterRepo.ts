// Usage counters (spec 2026-10-13 §1): one row per UTC day and counter key — provider email
// sends against the Resend caps, live Google calls per method, 429s served. The ops Health tab
// reads them; nothing else does. add() ADDS (an upsert of `n + excluded.n`), so two writers can
// never lose a count. Days are 'YYYY-MM-DD' strings — see services/usageMeter.ts utcDay().

export interface UsageCounterRow {
  day: string;
  key: string;
  n: number;
}

export interface UsageCounterRepo {
  add(day: string, key: string, n: number): Promise<void>;
  // Inclusive at both ends; ordered by day, then key.
  range(fromDay: string, toDay: string): Promise<UsageCounterRow[]>;
}

export class InMemoryUsageCounterRepo implements UsageCounterRepo {
  private readonly rows = new Map<string, UsageCounterRow>();

  async add(day: string, key: string, n: number): Promise<void> {
    const id = `${day}|${key}`;
    const row = this.rows.get(id);
    if (row) row.n += n;
    else this.rows.set(id, { day, key, n });
  }

  async range(fromDay: string, toDay: string): Promise<UsageCounterRow[]> {
    return [...this.rows.values()]
      .filter((r) => r.day >= fromDay && r.day <= toDay)
      .sort((a, b) => (a.day === b.day ? a.key.localeCompare(b.key) : a.day.localeCompare(b.day)))
      .map((r) => ({ ...r }));
  }
}
