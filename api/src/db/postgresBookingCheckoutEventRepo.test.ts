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

  it('summarises the checkouts started since a moment, per booking (digest payments line)', async () => {
    // A window after every row already in the shared test DB, so the counts are exactly ours;
    // the rows are removed again so the next run's window does not drift forward.
    const [{ max }] = await sql<{ max: Date | null }[]>`SELECT max(at) AS max FROM booking_checkout_event`;
    const since = new Date(Math.max(Date.now(), max ? new Date(max).getTime() : 0) + 86_400_000);
    const at = (min: number) => new Date(since.getTime() + min * 60_000);
    const [paid, declined, cancelled, silent, retried, old, team] = Array.from({ length: 7 }, () => randomUUID());
    try {
      const ev = (bookingId: string | null, action: 'create' | 'checkout' | 'webhook', outcome: 'succeeded' | 'refused' | 'error' | 'settled' | 'failed' | 'dismissed' | 'pending', min: number) =>
        repo.record({ action, outcome, bookingId, source: 'server' }, at(min));
      await ev(paid!, 'checkout', 'succeeded', 1);
      await ev(paid!, 'webhook', 'settled', 2);
      await ev(declined!, 'checkout', 'succeeded', 3);
      await ev(declined!, 'webhook', 'failed', 4);
      await ev(cancelled!, 'checkout', 'succeeded', 5);
      await ev(cancelled!, 'webhook', 'dismissed', 6);
      await ev(silent!, 'checkout', 'succeeded', 7);
      await ev(silent!, 'webhook', 'pending', 8);
      await ev(retried!, 'checkout', 'succeeded', 9);
      await ev(retried!, 'webhook', 'failed', 10);
      await ev(retried!, 'checkout', 'succeeded', 11);
      await ev(retried!, 'webhook', 'settled', 12);
      await ev(old!, 'checkout', 'succeeded', -5);
      await ev(old!, 'webhook', 'settled', 1);
      await ev(team!, 'checkout', 'succeeded', 13);
      await ev(team!, 'webhook', 'settled', 14);
      await ev(randomUUID(), 'checkout', 'refused', 2);
      await ev(null, 'create', 'refused', 3);
      await ev(null, 'create', 'error', 4);
      await ev(null, 'create', 'refused', -10);

      expect(await repo.summarySince(since, { excludeBookingIds: [team!] })).toEqual({
        started: 5, paid: 2, declined: 1, cancelledAtGateway: 1, abandoned: 1, createRefused: 2,
      });
      expect((await repo.summarySince(since)).paid).toBe(3); // the team booking, when not excluded
    } finally {
      await sql`DELETE FROM booking_checkout_event WHERE at >= ${new Date(since.getTime() - 3_600_000)}`;
    }
  });

  it('refuses an action, outcome or source the code does not know', async () => {
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('create', 'maybe', 'server')`).rejects.toThrow();
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('hop', 'refused', 'server')`).rejects.toThrow();
    await expect(sql`INSERT INTO booking_checkout_event (action, outcome, source) VALUES ('create', 'refused', 'robot')`).rejects.toThrow();
  });
});
