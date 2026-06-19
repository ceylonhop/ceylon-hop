import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

// SSL is required for hosted Postgres (Supabase) but absent on local/CI Postgres.
function sslFor(url: string): 'require' | false {
  return /localhost|127\.0\.0\.1/.test(url) ? false : 'require';
}

export function createDb(url: string) {
  const sql = postgres(url, { ssl: sslFor(url) });
  const db = drizzle(sql, { schema });
  return { sql, db };
}

export type Db = ReturnType<typeof createDb>['db'];
