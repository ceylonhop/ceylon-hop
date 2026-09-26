import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(
  new URL('../../drizzle/0056_payment_event_idempotency.sql', import.meta.url),
  'utf8',
);
const journal = JSON.parse(
  readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8'),
) as { entries: Array<{ idx: number; when: number; tag: string }> };

const stripSqlComments = (sql: string): string =>
  sql
    .split('\n')
    .map((line) => line.replace(/--.*$/, ''))
    .join('\n');

describe('0056_payment_event_idempotency', () => {
  const sql = stripSqlComments(migration);

  it('replaces global gateway-event uniqueness with payment-scoped uniqueness', () => {
    expect(sql).toMatch(
      /alter table "payment_events"\s+drop constraint if exists "payment_events_provider_txn_status_unique"/i,
    );
    expect(sql).toMatch(
      /constraint "payment_events_payment_provider_txn_status_unique"\s+unique\s*\(\s*"payment_id"\s*,\s*"provider"\s*,\s*"provider_txn_id"\s*,\s*"provider_status_code"\s*\)/i,
    );
  });

  it('does not rewrite existing payment evidence', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|update\s+\w+\s+set|delete\s+from)\b/i);
  });

  it('is journalled after 0055', () => {
    // Looked up by tag, not "the last entry": every later migration (0057 onwards) is appended after it.
    const at = journal.entries.findIndex((e) => e.tag === '0056_payment_event_idempotency');
    expect(journal.entries[at]).toMatchObject({ idx: 56, tag: '0056_payment_event_idempotency' });
    expect(journal.entries[at - 1]).toMatchObject({ tag: '0055_booking_checkout_event' });
    expect(journal.entries[at]!.when).toBeGreaterThan(journal.entries[at - 1]!.when);
  });
});
