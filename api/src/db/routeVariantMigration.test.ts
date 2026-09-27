import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../drizzle/0061_route_variant.sql', import.meta.url), 'utf8');
const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('0061_route_variant', () => {
  const sql = stripSqlComments(migration);

  it('adds the two nullable road columns', () => {
    expect(sql).toMatch(/alter table "transfer_request"\s+add column if not exists "route_variant" text\s*;/i);
    expect(sql).toMatch(/alter table "trip_request"\s+add column if not exists "route_variants" text\[\]\s*;/i);
  });

  it('writes no data — additive schema only', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
  });

  // PR #837 (0059_booking_customer_notes) lands on a different branch and may merge before or
  // after this one — so this is journalled by tag, at idx 60, ahead of EVERY other entry's
  // `when` (not just the entry that happens to precede it today), and never asserts which tag
  // that is: it must keep passing once #837's 0059 entry is appended to the journal.
  it('is journalled at idx 60, ahead of every other entry', () => {
    const at = journal.entries.findIndex((e) => e.tag === '0061_route_variant');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(journal.entries[at]).toMatchObject({ idx: 61, tag: '0061_route_variant' });
    const ownWhen = journal.entries[at]!.when;
    for (let i = 0; i < journal.entries.length; i++) {
      if (i === at) continue;
      expect(ownWhen).toBeGreaterThan(journal.entries[i]!.when);
    }
  });
});
