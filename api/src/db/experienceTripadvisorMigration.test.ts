import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Live Tripadvisor ratings (spec 2026-10-06 D22): the ONLY thing stored is the listing's location id.
// Additive only — one nullable column with no default, so the auto-apply on Render boot can't touch data.
const migration = readFileSync(new URL('../../drizzle/0068_experience_tripadvisor.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0068_experience_tripadvisor', () => {
  it('adds one nullable text column to experiences, with no default', () => {
    expect(sql).toMatch(/alter table "experiences" add column "tripadvisor_location_id" text(?!\s+not null)/i);
    expect(sql).not.toMatch(/not null|default/i);
  });
  it('checks the id is 1-15 digits (or null)', () => {
    expect(sql).toMatch(/"tripadvisor_location_id" is null or "tripadvisor_location_id" ~ '\^\[0-9\]\{1,15\}\$'/);
  });
  it('only adds the column: no DML, no drops, no other table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experiences")/i);
  });
  // Looked up by tag, not position: idx 66 (#940) and 67 (#950) land from other branches. drizzle orders by `when`.
  it('is journalled at idx 68 with a `when` after 0067’s (1791331200000)', () => {
    const e = journal.entries.find((x) => x.tag === '0068_experience_tripadvisor');
    const prev = journal.entries.find((x) => x.tag === '0067_experience_confirmation');
    expect(e, 'journal entry for 0068').toBeDefined();
    expect(e!.idx).toBe(68);
    expect(e!.when).toBe(1791417600000);
    expect(e!.when).toBeGreaterThan(prev!.when);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experiences.tripadvisor_location_id on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  const insert = (slug: string, id: string | null) => db`
    INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng, tripadvisor_location_id)
    VALUES (${slug}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76, ${id})`;

  it('accepts null and digits up to 15', async () => {
    await insert('mig-ta-null-' + Date.now(), null);
    await insert('mig-ta-ok-' + Date.now(), '123456789012345');
  });
  it('refuses a URL, a letter, an empty string and 16 digits', async () => {
    const t = Date.now();
    for (const [i, bad] of ['https://x', '12a', '', '1234567890123456'].entries()) {
      await expect(insert(`mig-ta-bad-${t}-${i}`, bad)).rejects.toThrow(/experiences_tripadvisor_location_id_digits/);
    }
  });
});
