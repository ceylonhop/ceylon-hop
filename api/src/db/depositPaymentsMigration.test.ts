import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Deposits (spec 2026-10-07 §4): one booking can now hold a deposit and a balance payment.
const TAG = '0066_deposit_payments';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('adds payments.purpose, defaulting existing rows to full', () => {
    expect(sql).toMatch(/alter table "payments" add column if not exists "purpose" text default 'full' not null/i);
    expect(sql).toMatch(/"payments_purpose_valid" check \("purpose" in \('full', 'deposit', 'balance'\)\)/i);
  });
  it('adds the frozen deposit amount on quotes', () => {
    expect(sql).toMatch(/alter table "quotes" add column if not exists "pay_link_deposit_cents" integer/i);
    expect(sql).toMatch(/"quotes_pay_link_deposit_cents_positive" check \("pay_link_deposit_cents" is null or "pay_link_deposit_cents" > 0\)/i);
  });
  it('allows the balance receipt kind', () => {
    expect(sql).toMatch(/'deposit_received', 'balance_received'\)/);
  });
  it('changes no rows', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });
  it('is journalled, and the journal `when` strictly increases in array order', () => {
    expect(journal.entries.some((e) => e.tag === TAG)).toBe(true);
    journal.entries.forEach((e, i) => {
      if (i > 0) expect(e.when, `${e.tag} must be newer than ${journal.entries[i - 1]!.tag}`).toBeGreaterThan(journal.entries[i - 1]!.when);
    });
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
  it('payments.purpose is not null with default full', async () => {
    const rows = await db<{ is_nullable: string; column_default: string }[]>`
      SELECT is_nullable, column_default FROM information_schema.columns
      WHERE table_name = 'payments' AND column_name = 'purpose'`;
    expect(rows[0]).toMatchObject({ is_nullable: 'NO' });
    expect(rows[0]!.column_default).toMatch(/'full'/);
  });
  it('the three constraints exist on the migrated database', async () => {
    const rows = await db<{ conname: string; def: string }[]>`
      SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
      WHERE conname IN ('payments_purpose_valid', 'quotes_pay_link_deposit_cents_positive', 'customer_communications_kind_valid')`;
    const def = (name: string) => rows.find((r) => r.conname === name)?.def ?? '';
    expect(rows.map((r) => r.conname).sort()).toEqual([
      'customer_communications_kind_valid', 'payments_purpose_valid', 'quotes_pay_link_deposit_cents_positive',
    ]);
    for (const v of ['full', 'deposit', 'balance']) expect(def('payments_purpose_valid')).toContain(`'${v}'`);
    expect(def('quotes_pay_link_deposit_cents_positive')).toContain('> 0');
    expect(def('customer_communications_kind_valid')).toContain("'deposit_received'");
    expect(def('customer_communications_kind_valid')).toContain("'balance_received'");
  });
});
