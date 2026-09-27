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

  // RELEASE ORDER IS HARD: this 0061 (when 1790812800000) must release after 0059 (#837) and
  // 0060_customer_communications (#850). drizzle applies only migrations whose `when` is newer than
  // the last one applied, so if 0061 reached a database first, those would be silently skipped
  // there forever. This test finds 0061 by tag and requires its `when` to be ahead of EVERY other
  // entry, so a later migration landing first (and taking a lower `when`) fails here loudly.
  it('is journalled at idx 61, ahead of every other entry', () => {
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
