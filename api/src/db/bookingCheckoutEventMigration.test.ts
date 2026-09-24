import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../drizzle/0055_booking_checkout_event.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};

const stripSqlComments = (sql: string): string => sql.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

const allowed = (sql: string, constraint: string, column: string): Set<string> => {
  const m = sql.match(new RegExp(`CONSTRAINT\\s+"${constraint}"\\s+CHECK\\s*\\(\\s*"${column}"\\s+in\\s*\\(([^)]*)\\)\\s*\\)`, 'i'));
  expect(m, `expected a CONSTRAINT "${constraint}" CHECK ("${column}" in (...)) clause`).not.toBeNull();
  return new Set((m![1] ?? '').split(',').map((v) => v.trim().replace(/^'|'$/g, '')).filter(Boolean));
};

describe('0055_booking_checkout_event', () => {
  const sql = stripSqlComments(migration);

  it('creates the table with the closed action / outcome / source sets', () => {
    expect(sql).toMatch(/create table if not exists "booking_checkout_event"/i);
    expect(allowed(sql, 'booking_checkout_event_action_known', 'action')).toEqual(
      new Set(['create', 'checkout', 'gateway', 'webhook', 'return']),
    );
    expect(allowed(sql, 'booking_checkout_event_outcome_known', 'outcome')).toEqual(
      new Set(['succeeded', 'refused', 'error', 'opened', 'dismissed', 'failed', 'settled', 'pending']),
    );
    expect(allowed(sql, 'booking_checkout_event_source_known', 'source')).toEqual(new Set(['server', 'client']));
  });

  it('has no foreign key: a refused create has no booking to point at', () => {
    expect(sql).not.toMatch(/references/i);
  });

  it('adds the two payment columns additively, with a default the existing rows can take', () => {
    expect(sql).toMatch(/alter table "payments" add column if not exists "attempt_count" integer default 0 not null/i);
    expect(sql).toMatch(/alter table "payments" add column if not exists "last_attempt_at" timestamp with time zone/i);
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });

  it('is journalled after 0054', () => {
    const last = journal.entries[journal.entries.length - 1]!;
    expect(last.tag).toBe('0055_booking_checkout_event');
    expect(last.idx).toBe(55);
    expect(last.when).toBeGreaterThan(journal.entries[journal.entries.length - 2]!.when);
  });
});
