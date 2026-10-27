import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// known-bugs 2026-07-30 / 2026-08-04: a trip's self-arranged stretches (the customer's own
// Ella → Galle train, or the leg a partial pay link left out) were priced out but never stored, so
// every consecutive stop pair read back as a leg we drive.
const TAG = '0076_trip_request_gaps';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('adds a nullable gaps array to trip_request, and nothing else', () => {
    expect(sql).toMatch(/alter table "trip_request" add column if not exists "gaps" integer\[\];/i);
    expect(sql).not.toMatch(/\bnot null\b|\bdefault\b/i);
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table|drop\s+column)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });

  it('is journalled after every other entry (drizzle skips an older `when`)', () => {
    const me = journal.entries.find((e) => e.tag === TAG);
    expect(me).toBeTruthy();
    const others = journal.entries.filter((e) => e.tag !== TAG).map((e) => e.when);
    expect(me!.when).toBeGreaterThan(Math.max(...others));
    // 0075 (#1070) is stamped 1792281600000 and must release first; nothing at or below it.
    expect(me!.when).toBeGreaterThan(1792281600000);
  });
});

describe.skipIf(!TEST_URL)(`${TAG} (Postgres)`, () => {
  let conn: ReturnType<typeof createDb>;
  let repo: PostgresBookingRepo;

  const trip = (gaps?: number[]): NewBooking => ({
    mode: 'trip',
    total: 30000,
    amountDueNow: 30000,
    currency: 'USD',
    input: {
      stops: ['Colombo', 'Ella', 'Galle', 'Colombo'],
      nights: [0, 0, 0],
      pax: 2,
      vehicleType: 'car',
      serviceType: 'private',
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' },
      ...(gaps ? { gaps } : {}),
    },
  });

  beforeAll(async () => {
    conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresBookingRepo(conn.db);
  });

  it('stores the gaps and reads them back on the booking', async () => {
    const created = await repo.create(trip([1]));
    const got = await repo.get(created.id);
    if (got?.mode !== 'trip') throw new Error('expected a trip booking');
    expect(got.input.gaps).toEqual([1]);
  });

  it('writes the gap as a `gap` leg, every other pair as a leg', async () => {
    const created = await repo.create(trip([1]));
    const rows = await conn.sql<{ seq: number; kind: string }[]>`
      select seq, kind from booking_legs where booking_id = ${created.id} order by seq`;
    expect(rows.map((r) => r.kind)).toEqual(['leg', 'gap', 'leg']);
  });

  it('a trip with no gaps reads back with the key absent, not null or []', async () => {
    const created = await repo.create(trip());
    const got = await repo.get(created.id);
    if (got?.mode !== 'trip') throw new Error('expected a trip booking');
    expect('gaps' in got.input).toBe(false);
    const [row] = await conn.sql<{ gaps: number[] | null }[]>`
      select gaps from trip_request where booking_id = ${created.id}`;
    expect(row.gaps).toBeNull();
  });
});
