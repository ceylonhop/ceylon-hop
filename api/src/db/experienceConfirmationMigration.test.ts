import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

// Experience confirmation email (spec 2026-10-06 D21): when and where, and whether we told the customer.
// Additive only — four nullable columns on experience_interests, so the auto-apply on Render boot
// can't touch data.
const migration = readFileSync(new URL('../../drizzle/0067_experience_confirmation.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0067_experience_confirmation', () => {
  it('adds the four columns to experience_interests, all nullable with no default', () => {
    expect(sql).toMatch(/alter table "experience_interests" add column "scheduled_date" date(?!\s+not null)/i);
    expect(sql).toMatch(/add column "scheduled_time" text/i);
    expect(sql).toMatch(/add column "meeting_point" text/i);
    expect(sql).toMatch(/add column "confirmation_sent_at" timestamp with time zone/i);
    expect(sql).not.toMatch(/not null|default/i);
  });
  it('checks the time is HH:MM and the meeting point is at most 200 characters', () => {
    expect(sql).toMatch(/"scheduled_time" is null or "scheduled_time" ~ '\^\(\[01\]\[0-9\]\|2\[0-3\]\):\[0-5\]\[0-9\]\$'/);
    expect(sql).toMatch(/"meeting_point" is null or char_length\("meeting_point"\) <= 200/);
  });
  it('only adds columns: no DML, no drops, no other table', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+|create\s+table)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter\s+table\s+"(?!experience_interests")/i);
  });
  // Looked up by tag, not position: idx 66 (0066_deposit_payments, PR #940) lands from another branch,
  // so this branch has a gap there. drizzle orders by `when`, never idx.
  it('is journalled at idx 67 with a `when` after 0065 and after 0066’s (1791244800000)', () => {
    const e = journal.entries.find((x) => x.tag === '0067_experience_confirmation');
    const prev = journal.entries.find((x) => x.tag === '0065_experiences');
    expect(e, 'journal entry for 0067').toBeDefined();
    expect(e!.idx).toBe(67);
    expect(e!.when).toBeGreaterThan(prev!.when);
    expect(e!.when).toBeGreaterThan(1791244800000);
  });
});

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('experience_interests confirmation columns on a migrated database', () => {
  let db: ReturnType<typeof createDb>['sql'];
  let interestId: string;
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    const [e] = await db<{ id: string }[]>`
      INSERT INTO experiences (slug, name, partner_name, area_label, summary, price_cents, price_unit, lat, lng)
      VALUES (${'mig-conf-' + Date.now()}, 'x', 'y', 'Sigiriya', 'z', 100, 'per_person', 7.95, 80.76) RETURNING id`;
    const [q] = await db<{ id: string }[]>`
      INSERT INTO quotes (reference, product, vehicle, total_cents, currency, rate_card_version, margin_cents, request_json, result_json)
      VALUES (${'Q-MC' + Date.now()}, 'private', 'car', 100, 'USD', 'v', 0, '{}', '{}') RETURNING id`;
    const [i] = await db<{ id: string }[]>`
      INSERT INTO experience_interests (experience_id, quote_id, source, name_snapshot, price_cents_snapshot, price_unit_snapshot)
      VALUES (${e!.id}, ${q!.id}, 'quote_page', 'x', 100, 'per_person') RETURNING id`;
    interestId = i!.id;
  });

  it('accepts a valid schedule and leaves the confirmation unsent', async () => {
    await db`UPDATE experience_interests SET scheduled_date = '2026-11-21', scheduled_time = '09:30', meeting_point = 'Hotel lobby' WHERE id = ${interestId}`;
    const [r] = await db<{ scheduled_date: string; scheduled_time: string; confirmation_sent_at: Date | null }[]>`
      SELECT scheduled_date::text, scheduled_time, confirmation_sent_at FROM experience_interests WHERE id = ${interestId}`;
    expect(r).toMatchObject({ scheduled_date: '2026-11-21', scheduled_time: '09:30', confirmation_sent_at: null });
  });
  it('refuses a malformed time and an over-long meeting point', async () => {
    await expect(db`UPDATE experience_interests SET scheduled_time = '9:30' WHERE id = ${interestId}`).rejects.toThrow(/experience_interests_time_valid/);
    await expect(db`UPDATE experience_interests SET scheduled_time = '24:00' WHERE id = ${interestId}`).rejects.toThrow(/experience_interests_time_valid/);
    await expect(db`UPDATE experience_interests SET meeting_point = ${'x'.repeat(201)} WHERE id = ${interestId}`).rejects.toThrow(/experience_interests_meeting_point_length/);
  });
});
