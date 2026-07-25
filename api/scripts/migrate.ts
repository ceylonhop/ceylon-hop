import 'dotenv/config';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from '../src/db/client';

// Applies pending Drizzle migrations to the test / CI database, failing loudly (non-zero exit)
// if they don't apply. Uses DATABASE_URL_TEST (falling back to DATABASE_URL) via createDb, which
// disables SSL for local/CI Postgres. Deliberately separate from `npm run migrate` (drizzle-kit,
// which targets the hosted DB with sslmode=require and would fail against a local server).
const url = process.env.DATABASE_URL_TEST ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL_TEST (or DATABASE_URL) must be set to migrate the test DB');
  process.exit(1);
}

const { db, sql } = createDb(url);
await migrate(db, { migrationsFolder: 'drizzle' });
await sql.end();
console.log('✓ test DB migrations applied');
