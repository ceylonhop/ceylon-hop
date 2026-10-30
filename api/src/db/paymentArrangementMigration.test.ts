import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

const TAG = '0077_booking_payment_arrangement';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('adds a nullable payment_arrangement with no default', () => {
    expect(sql).toMatch(/ALTER TABLE "bookings" ADD COLUMN IF NOT EXISTS "payment_arrangement" text;/);
    expect(sql).not.toMatch(/payment_arrangement"?\s+text\s+(not null|default)/i);
  });
  it('admits only on_the_day', () => {
    expect(sql).toMatch(/bookings_payment_arrangement_valid/);
    expect(sql).toMatch(/payment_arrangement IS NULL OR payment_arrangement IN \('on_the_day'\)/);
  });
  it('keeps every existing email kind and adds pay_on_day_confirmed', () => {
    for (const k of ['confirmation', 'details_needed', 'booking_confirmed', 'cancellation', 'refund', 'no_show_notice',
      'trip_reminder', 'review_request', 'payment_recovery', 'payment_failed', 'deposit_received', 'balance_received',
      'schedule_set', 'details_reminder_1', 'details_reminder_2', 'pay_on_day_confirmed']) {
      expect(sql).toContain(`'${k}'`);
    }
  });
  it('changes no rows and drops no table or column', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table|drop\s+column)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled as idx 77, after every other entry', () => {
    const entry = journal.entries.find((e) => e.tag === TAG);
    expect(entry?.idx).toBe(77);
    const others = journal.entries.filter((e) => e.tag !== TAG).map((e) => e.when);
    expect(entry!.when).toBeGreaterThan(Math.max(...others));
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;
describe.skipIf(!TEST_URL)(`${TAG} on a migrated database`, () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  it('payment_arrangement is nullable with no default', async () => {
    const rows = await db<{ is_nullable: string; column_default: string | null }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'bookings' AND column_name = 'payment_arrangement'`;
    expect(rows[0]).toMatchObject({ is_nullable: 'YES', column_default: null });
  });
  it('both constraints exist on the migrated database', async () => {
    const rows = await db<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('bookings_payment_arrangement_valid', 'customer_communications_kind_valid')`;
    const def = (name: string) => rows.find((r) => r.conname === name)?.def ?? '';
    expect(def('bookings_payment_arrangement_valid')).toContain("'on_the_day'");
    expect(def('customer_communications_kind_valid')).toContain("'pay_on_day_confirmed'");
    expect(def('customer_communications_kind_valid')).toContain("'details_reminder_2'");
  });
});
