import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Partner experiences (spec 2026-10-06 D3–D5): the catalogue and one row per customer interest.
// Additive only — no existing table changes, so the auto-apply on Render boot can't touch data.
const migration = readFileSync(new URL('../../drizzle/0065_experiences.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0065_experiences', () => {
  it('creates both tables', () => {
    expect(sql).toMatch(/create table "experiences"/i);
    expect(sql).toMatch(/create table "experience_interests"/i);
  });
  it('touches no existing table and moves no data', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+)/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    // The only ALTERs allowed are RLS on the two new tables (below); nothing existing is altered.
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experiences"|experience_interests")/i);
  });
  it('keeps both tables private from PostgREST, like every table since 0048 (rlsEnabled.test.ts)', () => {
    expect(sql).toMatch(/alter table "experiences" enable row level security/i);
    expect(sql).toMatch(/alter table "experience_interests" enable row level security/i);
    expect(sql).toMatch(/revoke all on table "experiences", "experience_interests" from public/i);
  });
  it('keeps money as cents + a supported currency', () => {
    expect(sql).toMatch(/"price_cents" integer NOT NULL/);
    expect(sql).toMatch(/"currency" in \('USD'\)/);
    expect(sql).toMatch(/"amount_paid_currency" in \('USD', 'LKR'\)/);
  });
  it('refuses "paid" without a payment reference', () => {
    expect(sql).toMatch(/experience_interests_paid_has_ref/);
  });
  it('makes a repeated tap idempotent per booking and per quote', () => {
    expect(sql).toMatch(/unique index "experience_interests_booking_uq"/i);
    expect(sql).toMatch(/unique index "experience_interests_quote_uq"/i);
  });
  it('is journalled after 0064', () => {
    const i = journal.entries.findIndex((e) => e.tag === '0065_experiences');
    expect(journal.entries[i]!.idx).toBe(65);
    expect(journal.entries[i]!.when).toBeGreaterThan(journal.entries[i - 1]!.when);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experiences tables on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });

  it('refuses an interest that belongs to neither a booking nor a quote', async () => {
    const [e] = await db<{ id: string }[]>`
      INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng)
      VALUES (${'mig-test-' + Date.now()}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76) RETURNING id`;
    await expect(db`
      INSERT INTO experience_interests (experience_id, source, name_snapshot, price_cents_snapshot, price_unit_snapshot)
      VALUES (${e!.id}, 'booking_page', 'x', 100, 'per_person')`).rejects.toThrow(/experience_interests_has_owner/);
  });
});
