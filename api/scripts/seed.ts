// Seed a database with the corridor catalogue — used to bootstrap a fresh staging (or local)
// DB without booting the full server. The API also seeds corridors on every boot
// (see src/server.ts), so this is a convenience for setup and CI, not the only path.
//
// Applies pending migrations first so it works against a brand-new, empty database, then
// idempotently upserts the corridors. Reads DATABASE_URL from the environment / api/.env.
//
//   DATABASE_URL=postgres://… npm run seed
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { config } from '../src/config';
import { createDb } from '../src/db/client';
import { seedCorridors } from '../src/db/postgresDepartureRepo';

const url = config.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is required to seed (set it in api/.env or the environment).');
  process.exit(1);
}

const { db, sql } = createDb(url);
try {
  const migrationsFolder = fileURLToPath(new URL('../drizzle', import.meta.url));
  console.log(`Applying migrations from ${migrationsFolder} …`);
  await migrate(db, { migrationsFolder });
  console.log('Seeding corridor catalogue …');
  await seedCorridors(sql);
  console.log('Seed complete.');
} finally {
  await sql.end();
}
