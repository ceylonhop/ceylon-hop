import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresRideBoardEventRepo } from './postgresRideBoardEventRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The in-memory repo backs every route test; only a real Postgres proves the migration, the
// column mapping and the timestamp binding (see the drizzle Date trap, #546).
describe.skipIf(!TEST_URL)('PostgresRideBoardEventRepo (integration)', () => {
  let repo: PostgresRideBoardEventRepo;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresRideBoardEventRepo(conn.db);
  });

  it('round-trips a full event and returns only those since the given time, oldest first', async () => {
    const marker = `T-${Date.now()}`;
    const t0 = new Date(Date.now() - 60_000);
    await repo.record({ action: 'join', outcome: 'refused', reason: 'closed', listCode: marker }, new Date(t0.getTime() - 1000));
    await repo.record({
      action: 'join', outcome: 'refused', reason: 'closed', httpStatus: 409, listCode: marker,
      corridorId: 'ella-east', fromPlace: 'Ella', toPlace: 'Arugam Bay', rideDate: '2026-09-24', slot: 'morning',
      seats: 2, customerSub: 'sub-1', country: 'DE', orderId: null,
    }, new Date(t0.getTime() + 1000));
    await repo.record({ action: 'start', outcome: 'payment_started', listCode: marker, orderId: 'RBPA-1' }, new Date(t0.getTime() + 2000));

    const rows = (await repo.since(t0)).filter((r) => r.listCode === marker);
    expect(rows.map((r) => r.outcome)).toEqual(['refused', 'payment_started']);
    expect(rows[0]).toMatchObject({
      action: 'join', reason: 'closed', httpStatus: 409, corridorId: 'ella-east', fromPlace: 'Ella',
      toPlace: 'Arugam Bay', rideDate: '2026-09-24', slot: 'morning', seats: 2, customerSub: 'sub-1',
      country: 'DE', orderId: null,
    });
    expect(rows[0].at.getTime()).toBe(t0.getTime() + 1000);
  });

  it('refuses an action or outcome the code does not know', async () => {
    await expect(sql`INSERT INTO ride_board_event (action, outcome) VALUES ('join', 'maybe')`).rejects.toThrow();
    await expect(sql`INSERT INTO ride_board_event (action, outcome) VALUES ('hop', 'refused')`).rejects.toThrow();
  });
});
