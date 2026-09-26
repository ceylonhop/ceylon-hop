import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresRateRevisionRepo } from './postgresRateRevisionRepo';
import { StaleRatesError } from './rateRevisionRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';

const TEST_URL = process.env.DATABASE_URL_TEST;
const RATES = ratesFromCard(RATE_CARD);

// The in-memory repo backs every route test; only a real Postgres proves the migration, the jsonb
// round trip of fractional per-km cents, and the unique-seq race guard.
describe.skipIf(!TEST_URL)('PostgresRateRevisionRepo (integration)', () => {
  let repo: PostgresRateRevisionRepo;
  let sql: Sql;
  const marker = `rates-it-${Date.now()}@e2e.test`;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresRateRevisionRepo(conn.db);
  });
  // The shared test DB outlives a run: leave no revision behind for the next one.
  afterAll(async () => {
    await sql`DELETE FROM rate_card_revisions WHERE created_by = ${marker}`;
  });

  it('appends numbered rows and reads the newest back exactly', async () => {
    const base = (await repo.latest())?.version ?? null;
    const a = await repo.create({ rates: RATES, baseVersion: base, createdBy: marker }, new Date('2026-09-27T08:00:00Z'));
    const b = await repo.create(
      { rates: { ...RATES, bufferPct: 12 }, baseVersion: a.version, revertedToVersion: '2026-07-14', createdBy: marker },
      new Date('2026-09-27T09:00:00Z'),
    );
    expect(b.seq).toBe(a.seq + 1);
    expect(b.version).toBe(`2026-09-27.${b.seq}`);
    const latest = await repo.latest();
    expect(latest).toMatchObject({ id: b.id, createdBy: marker, revertedToVersion: '2026-07-14' });
    expect(latest!.rates.bufferPct).toBe(12);
    expect(latest!.rates.perKmCents).toEqual(RATES.perKmCents); // 40.25, 54.05 … survive jsonb
    expect(latest!.createdAt.toISOString()).toBe('2026-09-27T09:00:00.000Z');
    expect((await repo.list()).slice(0, 2).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it('refuses a stale base, and lets exactly one of two racing saves land', async () => {
    const base = (await repo.latest())?.version ?? null;
    await expect(repo.create({ rates: RATES, baseVersion: 'not-the-latest', createdBy: marker }))
      .rejects.toBeInstanceOf(StaleRatesError);
    const results = await Promise.allSettled([
      repo.create({ rates: RATES, baseVersion: base, createdBy: marker }),
      repo.create({ rates: RATES, baseVersion: base, createdBy: marker }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    expect((results.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason).toBeInstanceOf(StaleRatesError);
  });
});
