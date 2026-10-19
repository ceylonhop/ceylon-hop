import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src/db/client';
import { requireConnectionUrl } from './lib/targetUrl';

// Applies pending Drizzle migrations to the test / CI database, failing loudly (non-zero exit)
// if they don't apply. Uses DATABASE_URL_TEST only, via createDb, which disables SSL for
// local/CI Postgres. Never falls back to DATABASE_URL: api/.env points that at production, so a
// fallback silently migrated prod whenever DATABASE_URL_TEST was unset. Deliberately separate
// from `npm run migrate` (drizzle-kit, which targets the hosted DB with sslmode=require and would
// fail against a local server).
let url: string;
try {
  url = requireConnectionUrl('DATABASE_URL_TEST', 'migrate');
} catch (err) {
  console.error((err as Error).message);
  process.exit(1);
}

const { db, sql } = createDb(url);
await migrate(db, { migrationsFolder: 'drizzle' });
await sql.end();
console.log('✓ test DB migrations applied');
