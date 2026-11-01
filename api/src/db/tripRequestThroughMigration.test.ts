import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

describe('0078_trip_request_through', () => {
  const sql = readFileSync(new URL('../../drizzle/0078_trip_request_through.sql', import.meta.url), 'utf8')
    .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

  it('adds a nullable integer[] column, idempotently', () => {
    expect(sql).toMatch(/alter table\s+"trip_request"\s+add column if not exists\s+"through"\s+integer\[\]/i);
    expect(sql).not.toMatch(/not null/i);
  });

  it('is journaled after 0077 so drizzle applies it on a database that already has 0077', () => {
    const e = journal.entries.find((x) => x.tag === '0078_trip_request_through');
    const prev = journal.entries.find((x) => x.tag === '0077_booking_payment_arrangement');
    expect(e).toBeDefined();
    expect(prev).toBeDefined();
    expect(e!.idx).toBe(78);
    expect(e!.when).toBeGreaterThan(prev!.when);
  });
});
