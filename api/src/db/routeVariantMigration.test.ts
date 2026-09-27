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

  // RELEASE ORDER IS HARD: PR #837's 0059_booking_customer_notes (when 1790640000000) must merge
  // and release BEFORE this 0060 (when 1790726400000). drizzle applies only migrations whose
  // `when` is newer than the last one applied, so if 0060 reached a database first, 0059 would be
  // silently skipped there forever. If the order must flip, #837 must re-stamp its `when` above
  // 0060's before it merges. This test finds 0060 by tag at idx 60 and requires its `when` to be
  // ahead of EVERY other entry, so it keeps passing once #837's 0059 entry joins the journal.
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
