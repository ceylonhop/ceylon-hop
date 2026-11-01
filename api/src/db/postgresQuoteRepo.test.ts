import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresQuoteRepo } from './postgresQuoteRepo';

// Script genReference: tests push references to hand out next; when the queue is empty it
// falls through to the real generator.
const forcedRefs: string[] = [];
vi.mock('./quoteRepo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./quoteRepo')>();
  return { ...actual, genReference: () => forcedRefs.shift() ?? actual.genReference() };
});

const TEST_URL = process.env.DATABASE_URL_TEST;

const input = {
  channel: 'ops' as const,
  product: 'private' as const,
  vehicle: 'car',
  customerName: 'Reference Collision Test',
  totalCents: 12000,
  currency: 'USD',
  rateCardVersion: 'reference-collision-test',
  request: {},
  result: {},
};

describe.skipIf(!TEST_URL)('PostgresQuoteRepo.save reference collision (integration)', () => {
  let repo: PostgresQuoteRepo;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    repo = new PostgresQuoteRepo(conn.db);
  });

  afterAll(async () => {
    await sql.end();
  });

  // Drizzle wraps the driver error ("Failed query: …") with the PostgresError on `.cause`, so a
  // check that only reads the top-level error never saw the collision and save() threw.
  it('retries with a fresh reference when the generated one is already taken', async () => {
    const first = await repo.save(input);
    forcedRefs.push(first.reference);

    const second = await repo.save(input);

    expect(forcedRefs).toEqual([]);
    expect(second.reference).not.toBe(first.reference);
    expect(second.reference).toMatch(/^Q-/);
  });
});
