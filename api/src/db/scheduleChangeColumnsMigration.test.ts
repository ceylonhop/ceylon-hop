import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// Ops date/time changes (requirements 2026-10-26, option A): the reason and note on each change,
// which leg a multi-stop change moved, and the "Driver told?" task.
const TAG = '0075_schedule_change_reason_leg_driver_task';
const migration = readFileSync(new URL(`../../drizzle/${TAG}.sql`, import.meta.url), 'utf8');
const journal = JSON.parse(readFileSync(new URL('../../drizzle/meta/_journal.json', import.meta.url), 'utf8')) as {
  entries: Array<{ idx: number; when: number; tag: string }>;
};
const sql = migration.split('\n').map((l) => l.replace(/--.*$/, '')).join('\n');

describe(TAG, () => {
  it('adds reason, note and leg to the schedule history', () => {
    expect(sql).toMatch(/alter table "booking_schedule_events" add column "reason" text;/i);
    expect(sql).toMatch(/alter table "booking_schedule_events" add column "note" text;/i);
    expect(sql).toMatch(/alter table "booking_schedule_events" add column "leg_id" uuid;/i);
    expect(sql).toMatch(/foreign key \("leg_id"\) references "public"\."booking_legs"\("id"\)/i);
  });

  it('allows only the form reasons, and none on older rows', () => {
    expect(sql).toMatch(/"reason" is null or "reason" in \(/i);
    for (const r of ['customer_changed_plans', 'customer_entered_wrong', 'flight_changed', 'our_mistake', 'other']) {
      expect(sql).toContain(`'${r}'`);
    }
  });

  it('adds the driver-task marker to ride_ops', () => {
    expect(sql).toMatch(/alter table "ride_ops" add column "driver_update_pending_since" timestamp with time zone;/i);
  });

  it('only adds nullable columns: no default, no NOT NULL, no row changes', () => {
    expect(sql).not.toMatch(/\bnot null\b|\bdefault\b/i);
    expect(sql).not.toMatch(/\b(insert\s+into|delete\s+from|drop\s+table|drop\s+column)\b/i);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
  });

  it('is journalled after every earlier migration (drizzle skips an older `when`)', () => {
    const me = journal.entries.find((e) => e.tag === TAG);
    expect(me).toBeTruthy();
    // Every EARLIER migration (lower idx), not every entry: a later migration is meant to sort after.
    const earlier = journal.entries.filter((e) => e.idx < me!.idx).map((e) => e.when);
    expect(me!.when).toBeGreaterThan(Math.max(...earlier));
    // Staging and local DBs recorded 0074 at its first stamp, so anything at or below it is skipped there.
    expect(me!.when).toBeGreaterThan(1792195200000);
  });
});

describe.skipIf(!TEST_URL)(`${TAG} (Postgres)`, () => {
  let conn: ReturnType<typeof createDb>;
  let bookingId: string;
  let legId: string;

  beforeAll(async () => {
    conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    const b = await new PostgresBookingRepo(conn.db).create({
      mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
      input: { from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1, date: '2026-11-04', time: '09:00',
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' } },
    });
    bookingId = b.id;
    [{ id: legId }] = await conn.sql<{ id: string }[]>`select id from booking_legs where booking_id = ${bookingId} limit 1`;
  });

  const insert = (reason: string | null, leg: string | null) => conn.sql`
    insert into booking_schedule_events (booking_id, from_date, to_date, actor_type, actor_id, reason, note, leg_id)
    values (${bookingId}, '2026-11-04', '2026-11-05', 'staff', 'ops@x.com', ${reason}, 'later flight', ${leg})`;

  it('records a reason, note and leg', async () => {
    await insert('flight_changed', legId);
    const [row] = await conn.sql`select reason, note, leg_id from booking_schedule_events where booking_id = ${bookingId}`;
    expect(row).toMatchObject({ reason: 'flight_changed', note: 'later flight', leg_id: legId });
  });

  it('refuses a reason outside the list, and a leg that does not exist', async () => {
    await expect(insert('bored', null)).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null, '00000000-0000-4000-8000-0000000000ff')).rejects.toMatchObject({ code: '23503' });
  });

  it('stores the driver-task marker on ride_ops', async () => {
    const at = new Date('2026-11-03T10:00:00Z');
    await conn.sql`insert into ride_ops (booking_id, driver_update_pending_since) values (${bookingId}, ${at})
      on conflict (booking_id) do update set driver_update_pending_since = excluded.driver_update_pending_since`;
    // drizzle() swaps the client's timestamp parser, so raw reads come back as strings (client.ts).
    const [row] = await conn.sql<{ t: string }[]>`select driver_update_pending_since as t from ride_ops where booking_id = ${bookingId}`;
    expect(new Date(row.t).toISOString()).toBe(at.toISOString());
  });
});
