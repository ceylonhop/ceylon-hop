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

  // RELEASE ORDER IS HARD: this 0061 must release after 0059 (#837) and
  // 0060_customer_communications (#850). Future migrations are valid only when their own `when`
  // is newer, so this checks the invariant against every entry that precedes 0061 in the journal.
  it('is journalled at idx 61, after every earlier entry', () => {
    const at = journal.entries.findIndex((e) => e.tag === '0061_route_variant');
    expect(at).toBeGreaterThanOrEqual(0);
    expect(journal.entries[at]).toMatchObject({ idx: 61, tag: '0061_route_variant' });
    const ownWhen = journal.entries[at]!.when;
    for (let i = 0; i < at; i++) {
      expect(ownWhen).toBeGreaterThan(journal.entries[i]!.when);
    }
    if (journal.entries[at + 1]) expect(journal.entries[at + 1]!.when).toBeGreaterThan(ownWhen);
  });
});
