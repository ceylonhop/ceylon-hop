import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// "Find the business on Google" (2026-10-18): the experience keeps Google's place id so its pin can be
// refreshed later. Additive only — one nullable column with no default, so the auto-apply on Render
// boot can't touch data.
const migration = readFileSync(new URL('../../drizzle/0074_experience_google_place_id.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0074_experience_google_place_id', () => {
  it('adds one nullable text column to experiences, with no default', () => {
    expect(sql).toMatch(/alter table "experiences" add column "google_place_id" text(?!\s+not null)/i);
    expect(sql).not.toMatch(/not null|default/i);
  });
  it('checks the id is 10-300 URL-safe characters (or null)', () => {
    expect(sql).toMatch(/"google_place_id" is null or "google_place_id" ~ '\^\[A-Za-z0-9_-\]\{10,300\}\$'/);
  });
  it('only adds the column: no DML, no drops, no other table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experiences")/i);
  });
  it('is journalled at idx 74 with a `when` after 0073’s (1792108800000)', () => {
    const e = journal.entries.find((x) => x.tag === '0074_experience_google_place_id');
    const prev = journal.entries.find((x) => x.tag === '0073_details_reminder_kinds');
    expect(e, 'journal entry for 0074').toBeDefined();
    expect(e!.idx).toBe(74);
    expect(e!.when).toBe(1792195200000);
    expect(e!.when).toBeGreaterThan(prev!.when);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experiences.google_place_id on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  const insert = (slug: string, id: string | null) => db`
    INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng, google_place_id)
    VALUES (${slug}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76, ${id})`;

  it('accepts null and a real-shaped place id', async () => {
    await insert('mig-gp-null-' + Date.now(), null);
    await insert('mig-gp-ok-' + Date.now(), 'ChIJN1t_tDeuEmsRUsoyG83frY4');
  });
  it('refuses a URL, a short string, an empty string and spaces', async () => {
    const t = Date.now();
    for (const [i, bad] of ['https://maps.google.com/x', 'short', '', 'ChIJ with spaces'].entries()) {
      await expect(insert(`mig-gp-bad-${t}-${i}`, bad)).rejects.toThrow(/experiences_google_place_id_shape/);
    }
  });
});
