import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';

/*
  Supabase's Security Advisor flagged every table in `public` as `rls_disabled_in_public`: the
  schema is exposed through PostgREST and Supabase's default grants hand `anon` full CRUD on it,
  so with RLS off a leaked anon key reads or deletes `payments` and `customers` wholesale.

  0048 turned RLS on across the schema. This is the guard that keeps it on: the migration loops
  over pg_tables, so it covers whatever exists WHEN IT RUNS — but a table created by a LATER
  migration arrives with RLS off and nothing would say so. That is precisely how the schema got
  into this state in the first place.

  No policies are asserted on purpose. RLS with no policy denies every row to every role subject
  to it, which is what we want for a surface we never use. The API is unaffected: it connects as
  `postgres`, which has rolbypassrls (verified on staging, 2026-08-19) and owns the tables.
*/
const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('every public table has RLS enabled', () => {
  let sql: ReturnType<typeof createDb>['sql'];

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });

  it('leaves no table in public without row-level security', async () => {
    const rows = await sql<{ tablename: string }[]>`
      SELECT c.relname AS tablename
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND NOT c.relrowsecurity
      ORDER BY c.relname`;
    const unprotected = rows.map((r) => r.tablename);
    expect(
      unprotected,
      `RLS is off on: ${unprotected.join(', ')}. A new table needs `
        + `ALTER TABLE public.<t> ENABLE ROW LEVEL SECURITY in its migration.`,
    ).toEqual([]);
  });

  it('covers a table created after the RLS migration ran', async () => {
    // Proves the guard can actually fail — without this, "no unprotected tables" could just as
    // easily mean the query is wrong as mean the schema is clean.
    await sql`CREATE TABLE IF NOT EXISTS public.rls_guard_probe (id int)`;
    try {
      const rows = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'r'
          AND NOT c.relrowsecurity AND c.relname = 'rls_guard_probe'`;
      expect(rows[0].n).toBe(1);
    } finally {
      await sql`DROP TABLE IF EXISTS public.rls_guard_probe`;
    }
  });
});
