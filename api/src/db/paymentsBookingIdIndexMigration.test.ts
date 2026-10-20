import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// payments.booking_id is a foreign key, and Postgres never indexes those on its own. Every
// payments read but the gateway's goes through it: the ops Bookings list, the watchdog, the pay
// link, refunds and the promo-use count. Until 0064 each of those scanned the whole table.
const migration = readFileSync(new URL('../../drizzle/0064_payments_booking_id_index.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0064_payments_booking_id_index', () => {
  it('indexes payments.booking_id', () => {
    expect(sql).toMatch(/create index if not exists "payments_booking_id_idx" on "payments" \("booking_id"\)/i);
  });
  it('is an index and nothing else: no DML, no drops, no table changes', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|alter\s+table|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled after 0063', () => {
    const position = journal.entries.findIndex((e) => e.tag === '0064_payments_booking_id_index');
    expect(journal.entries[position]!.idx).toBe(64);
    expect(journal.entries[position]!.when).toBeGreaterThan(journal.entries[position - 1]!.when);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('payments.booking_id index on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });

  it('exists, on booking_id alone', async () => {
    const rows = await db<{ indexdef: string }[]>`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename = 'payments' AND indexname = 'payments_booking_id_idx'`;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toMatch(/\(booking_id\)$/);
  });
});
