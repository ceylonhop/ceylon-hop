import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const migration = readFileSync(new URL('../../drizzle/0063_ga4_server_events.sql', import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe('0063_ga4_server_events', () => {
  it('creates the two analytics tables, both with RLS on', () => {
    expect(sql).toMatch(/create table if not exists "booking_ga_identity"/i);
    expect(sql).toMatch(/create table if not exists "ga4_event_log"/i);
    expect(sql).toMatch(/alter table "booking_ga_identity" enable row level security/i);
    expect(sql).toMatch(/alter table "ga4_event_log" enable row level security/i);
  });
  it('revokes public, anon and authenticated from both tables, like 0058', () => {
    for (const t of ['booking_ga_identity', 'ga4_event_log']) {
      expect(sql).toContain(`REVOKE ALL ON TABLE "${t}" FROM PUBLIC;`);
      expect(sql).toContain(`EXECUTE 'REVOKE ALL ON TABLE ${t} FROM anon';`);
      expect(sql).toContain(`EXECUTE 'REVOKE ALL ON TABLE ${t} FROM authenticated';`);
    }
    expect(sql.match(/FROM pg_roles WHERE rolname = 'anon'/g)).toHaveLength(2);
    expect(sql.match(/FROM pg_roles WHERE rolname = 'authenticated'/g)).toHaveLength(2);
  });
  it('pins the shapes: GA ids, consent, ledger kind and status', () => {
    expect(sql).toMatch(/"booking_ga_identity_client_id_shape"/);
    expect(sql).toMatch(/"booking_ga_identity_session_id_shape"/);
    expect(sql).toMatch(/"ad_consent" in \('granted', 'denied', 'unknown'\)/i);
    expect(sql).toMatch(/"kind" in \('purchase', 'refund', 'board_purchase'\)/i);
    expect(sql).toMatch(/"status" in \('claimed', 'sent', 'failed'\)/i);
    expect(sql).toMatch(/"event_key" text not null unique/i);
  });
  it('is additive: no DML, no drops, nothing on bookings or payments', () => {
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+(table|column))\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/alter table "(bookings|payments)"/i);
  });
  it('is journalled after 0062', () => {
    const position = journal.entries.findIndex((e) => e.tag === '0063_ga4_server_events');
    expect(journal.entries[position]!.idx).toBe(63);
    expect(journal.entries[position]!.when).toBeGreaterThan(journal.entries[position - 1]!.when);
  });
});
