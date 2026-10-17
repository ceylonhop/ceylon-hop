import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Partner experiences on the pay-link confirmation (owner, 2026-10-15, option B): a "Request info"
// tap on a paid pay link is recorded on the BOOKING with source 'pay_page'. The only schema change is
// widening experience_interests_source_valid; no column, no data touched.
const migration = readFileSync(new URL('../../drizzle/0070_experience_pay_page_source.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0070_experience_pay_page_source', () => {
  it('drops and re-adds experience_interests_source_valid with pay_page added', () => {
    expect(sql).toMatch(/alter table "experience_interests" drop constraint "experience_interests_source_valid"/i);
    expect(sql).toMatch(/alter table "experience_interests" add constraint "experience_interests_source_valid" check \("source" in \('booking_page', 'quote_page', 'pay_page'\)\)/i);
  });
  it('touches only that constraint: no DML, no columns, no other table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table|drop\s+column|add\s+column|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experience_interests")/i);
  });
  // drizzle applies by `when`, and SKIPS a migration whose `when` is older than the last one applied.
  // PR #976 (0071_usage_counters, still open) is journalled at 1791936000000. 0070 sits BETWEEN 0068 and
  // that, so this PR can ship first (owner, 2026-10-16: promote without waiting for #976) and #976 still
  // applies after it — #976's journal entry then goes after 0070's, with its higher `when`.
  it('is journalled at idx 70 with when 1791849600000: after 0068, and before #976’s 0071 (1791936000000)', () => {
    const e = journal.entries.find((x) => x.tag === '0070_experience_pay_page_source');
    const prev = journal.entries.find((x) => x.tag === '0068_experience_tripadvisor');
    expect(e, 'journal entry for 0070').toBeDefined();
    expect(e!.idx).toBe(70);
    expect(e!.when).toBe(1791849600000);
    expect(e!.when).toBeGreaterThan(prev!.when);
    expect(e!.when).toBeLessThan(1791936000000);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experience_interests.source on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  let experienceId: string;
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    const [e] = await db<{ id: string }[]>`
      INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng)
      VALUES (${'mig-pay-' + Date.now()}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76) RETURNING id`;
    experienceId = e!.id;
  });
  const insert = async (source: string) => {
    const [q] = await db<{ id: string }[]>`
      INSERT INTO quotes (reference, product, vehicle, total_cents, currency, rate_card_version, margin_cents, request_json, result_json)
      VALUES (${'Q-MP' + Date.now() + Math.floor(Math.random() * 1e6)}, 'private', 'car', 100, 'USD', 'v', 0, '{}', '{}') RETURNING id`;
    return db`
      INSERT INTO experience_interests (experience_id, quote_id, source, name_snapshot, price_cents_snapshot, price_unit_snapshot)
      VALUES (${experienceId}, ${q!.id}, ${source}, 'x', 100, 'per_person')`;
  };

  it('accepts pay_page alongside booking_page and quote_page', async () => {
    for (const s of ['booking_page', 'quote_page', 'pay_page']) await insert(s);
  });
  it('still refuses any other source', async () => {
    await expect(insert('email')).rejects.toThrow(/experience_interests_source_valid/);
  });
});
