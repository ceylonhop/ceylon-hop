import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresBookingCheckoutEventRepo } from './postgresBookingCheckoutEventRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The in-memory repo backs every route test; only a real Postgres proves migration 0055, the
// column mapping and the timestamp binding (see the drizzle Date trap, #546).
describe.skipIf(!TEST_URL)('PostgresBookingCheckoutEventRepo (integration)', () => {
  let repo: PostgresBookingCheckoutEventRepo;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresBookingCheckoutEventRepo(conn.db);
  });

  it('round-trips a full event and lists a booking’s attempts newest first', async () => {
    // No foreign key on purpose: a create that was refused has no booking row to point at.
    const bookingId = randomUUID();
    const t0 = new Date(Date.now() - 60_000);
    await repo.record({ action: 'create', outcome: 'succeeded', bookingId, reference: 'CH-TEST1', channel: 'website', httpStatus: 201, ua: 'UA/1', source: 'server' }, t0);
    await repo.record({
      action: 'gateway', outcome: 'error', bookingId, reference: 'CH-TEST1', orderId: 'CH-TEST1', channel: 'website',
      reason: 'PH-0014 hash mismatch', httpStatus: null, attempt: 2, ua: 'UA/2', source: 'client',
    }, new Date(t0.getTime() + 1000));
    await repo.record({ action: 'create', outcome: 'refused', reason: 'date_in_past', httpStatus: 400, source: 'server' });

    const rows = await repo.listByBookingId(bookingId);
    expect(rows.map((r) => r.action)).toEqual(['gateway', 'create']);
    expect(rows[0]).toMatchObject({
      outcome: 'error', bookingId, reference: 'CH-TEST1', orderId: 'CH-TEST1', channel: 'website',
      reason: 'PH-0014 hash mismatch', httpStatus: null, attempt: 2, ua: 'UA/2', source: 'client',
    });
    expect(rows[0]!.at.getTime()).toBe(t0.getTime() + 1000);
    expect(rows[1]).toMatchObject({ outcome: 'succeeded', httpStatus: 201, orderId: null, attempt: null });
  });

  it('refuses an action, outcome or source the code does not know', async () => {
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('create', 'maybe', 'server')`).rejects.toThrow();
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('hop', 'refused', 'server')`).rejects.toThrow();
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('create', 'refused', 'robot')`).rejects.toThrow();
  });
});
