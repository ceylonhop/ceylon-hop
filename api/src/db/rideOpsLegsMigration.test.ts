import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Per-leg ops steps (spec 2026-11-19): one ops-owned row per driven leg.
const TAG = '0080_ride_ops_legs';
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

describe(TAG, () => {
  const sql = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('creates ride_ops_legs keyed by the stored leg, idempotently', () => {
    expect(sql).toMatch(/create table if not exists\s+"ride_ops_legs"/i);
    expect(sql).toMatch(/"leg_id" uuid primary key not null/i);
    expect(sql).toMatch(/foreign key \("leg_id"\) references "public"\."booking_legs"\("id"\)/i);
  });

  it('starts a leg at paid and allows only the leg stages — no_show stays on the booking', () => {
    expect(sql).toMatch(/"fulfilment_status" text default 'paid' not null/i);
    expect(sql).toMatch(/check \("fulfilment_status" in \('paid', 'vehicle_confirmed', 'pickup_confirmed', 'on_trip', 'completed'\)\)/i);
    expect(sql).not.toMatch(/no_show/);
  });

  it('switches row-level security on for the new table', () => {
    expect(sql).toMatch(/alter table\s+"ride_ops_legs"\s+enable row level security/i);
  });

  it('is additive: touches no existing table', () => {
    const altered = [...sql.matchAll(/alter table\s+"(\w+)"/gi)].map((m) => m[1]);
    expect(altered).toEqual(['ride_ops_legs']);
    expect(sql).not.toMatch(/drop |update |delete /i);
  });

  it('is journaled after 0079 so drizzle applies it on a database that already has 0079', () => {
    const e = journal.entries.find((x) => x.tag === TAG);
    const prev = journal.entries.find((x) => x.tag === '0079_booking_add_ons');
    expect(e).toBeDefined();
    expect(e!.idx).toBe(80);
    expect(e!.when).toBeGreaterThan(prev!.when);
    expect(journal.entries[journal.entries.length - 1].tag).toBe(TAG);
  });
});
