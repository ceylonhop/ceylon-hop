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
  it('checks the id is 10-255 URL-safe characters (or null) — 255 is Postgres’s regex repetition cap', () => {
    expect(sql).toMatch(/"google_place_id" is null or "google_place_id" ~ '\^\[A-Za-z0-9_-\]\{10,255\}\$'/);
  });
  it('only adds the column: no DML, no drops, no other table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experiences")/i);
  });
  // Re-stamped 2026-10-18 to sit BETWEEN 0071 and 0072. drizzle applies only entries whose `when` is newer
  // than the newest one a database has recorded (pg-core/dialect.js), and prod had 0071 but not 0072/0073
  // (other branches' work). Promoted with the original stamp, 0074 would have made prod skip 0072 and 0073
  // forever. Looked up by tag: 0072/0073 aren't on every branch this file is cherry-picked onto.
  it('is journalled at idx 74, stamped after 0071 and before 0072', () => {
    const e = journal.entries.find((x) => x.tag === '0074_experience_google_place_id');
    const after = journal.entries.find((x) => x.tag === '0071_usage_counters');
    const before = journal.entries.find((x) => x.tag === '0072_booking_schedule_events');
    expect(e, 'journal entry for 0074').toBeDefined();
    expect(e!.idx).toBe(74);
    expect(e!.when).toBe(1791979200000);
    expect(e!.when).toBeGreaterThan(after!.when);
    if (before) expect(e!.when).toBeLessThan(before.when);
  });
  // Staging (and any local DB) ran 0074 under its FIRST stamp, 1792195200000, and keeps that as its newest
  // applied `when`. A later migration stamped at or below it would be skipped there, silently.
  it('every later migration is stamped above 0074’s first stamp (1792195200000)', () => {
    for (const x of journal.entries.filter((y) => y.idx > 74)) expect(x.when, x.tag).toBeGreaterThan(1792195200000);
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

  it('accepts null, a real-shaped place id and a 255-character one', async () => {
    await insert('mig-gp-null-' + Date.now(), null);
    await insert('mig-gp-ok-' + Date.now(), 'ChIJN1t_tDeuEmsRUsoyG83frY4');
    await insert('mig-gp-255-' + Date.now(), 'a'.repeat(255));
  });
  it('refuses a URL, a short string, an empty string and spaces', async () => {
    const t = Date.now();
    for (const [i, bad] of ['https://maps.google.com/x', 'short', '', 'ChIJ with spaces', 'a'.repeat(256)].entries()) {
      await expect(insert(`mig-gp-bad-${t}-${i}`, bad)).rejects.toThrow(/experiences_google_place_id_shape/);
    }
  });
});
