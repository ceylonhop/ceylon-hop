import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresRideListRepo } from './postgresRideListRepo';
import { seedCorridors } from './postgresDepartureRepo';
import { cutoffAt } from '../domain/rideList';
import type { CreateListArgs } from './rideListRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// Every ride-board test in this repo uses InMemoryRideListRepo. PostgresRideListRepo
// had ZERO integration coverage, so its INSERT met a real driver for the first time in
// production -- where creating a board 500s with
//   TypeError [ERR_INVALID_ARG_TYPE]: The "string" argument must be of type string...
//   Received an instance of Date   at PostgresRideListRepo.createList (:85)
// The values on that line are the two Dates (cutoff_at, created_at/updated_at) and the
// text `date`. Nothing but a real Postgres can tell us whether the SQL is at fault.
describe.skipIf(!TEST_URL)('PostgresRideListRepo (integration)', () => {
  let lists: PostgresRideListRepo;
  let sql: Sql;

  const args = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
    corridorId: 'ella-east',
    fromPlace: 'Ella',
    toPlace: 'Yala',
    date: '2999-08-08',
    slot: 'morning',
    minSeats: 3,
    capacity: 8,
    seatPrice: 2299,
    note: null,
    cutoffAt: cutoffAt('2999-08-08', 'morning'),
    createdBy: 'sub-creator',
    ...over,
  });

  const member = (sub: string, seats: number) => ({
    sub, firstName: sub, country: 'LK', email: `${sub}@x.com`, seats,
  });

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    await seedCorridors(sql);
    lists = new PostgresRideListRepo(sql);
  });

  // This is the exact call POST /board makes, Dates and all.
  it('creates a list, binding the Date and text columns the route actually passes', async () => {
    const now = new Date('2026-08-17T09:00:00Z');
    const list = await lists.createList(args({ initialStatus: 'pending_payment' }), now);

    expect(list.id).toBeTruthy();
    expect(list.code).toMatch(/^[A-Z]{2,}-\d{4}$/);
    expect(list.status).toBe('pending_payment');
    expect(list.date).toBe('2999-08-08'); // text column, not a Date
    expect(list.seatPrice).toBe(2299);
  });

  it('round-trips cutoff_at through Postgres as the same instant', async () => {
    const cutoff = cutoffAt('2999-08-08', 'morning');
    const list = await lists.createList(args({ cutoffAt: cutoff }));
    const [row] = await sql<{ cutoff_at: string; date: string }[]>`
      select cutoff_at, date from ride_list where id = ${list.id}`;
    // Read back as a STRING, not a Date: drizzle() also replaces postgres.js's parsers for
    // these OIDs, and createDb deliberately does not restore those -- every repo already
    // wraps its reads in `new Date(...)`, so widening the fix to the read path would change
    // what all of them receive for no bug. This asserts the asymmetry on purpose.
    expect(typeof row.cutoff_at).toBe('string');
    expect(new Date(row.cutoff_at).getTime()).toBe(cutoff.getTime());
    expect(row.date).toBe('2999-08-08'); // proves the driver stored text, not a timestamp
  });

  it('defaults status to gathering when the caller does not set one', async () => {
    const list = await lists.createList(args());
    expect(list.status).toBe('gathering');
  });

  // The ON CONFLICT branch of addMember is the re-join / seat-change upsert. It used to set
  // status = 'held' unconditionally, so a CHARGED member's own harmless re-tap erased the only
  // record that their money was taken. Only a real Postgres can prove the CASE in that upsert
  // does what the in-memory repo does.
  describe('addMember never downgrades a charged member', () => {
    it('keeps charged across a re-join, while still applying the seat change', async () => {
      const list = await lists.createList(args());
      await lists.addMember(list.id, member('paid-sub', 1));
      await lists.setMemberStatus(list.id, 'paid-sub', 'charged');

      const again = await lists.addMember(list.id, member('paid-sub', 2));

      expect(again?.status).toBe('charged');
      expect(again?.seats).toBe(2);
    });

    it('still reactivates a scratched member as held', async () => {
      const list = await lists.createList(args());
      await lists.addMember(list.id, member('gone-sub', 1));
      await lists.removeMember(list.id, 'gone-sub');

      expect((await lists.addMember(list.id, member('gone-sub', 1)))?.status).toBe('held');
    });
  });
});
