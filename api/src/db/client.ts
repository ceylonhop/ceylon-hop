import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from './schema';

// SSL is required for hosted Postgres (Supabase) but absent on local/CI Postgres.
function sslFor(url: string): 'require' | false {
  return /localhost|127\.0\.0\.1/.test(url) ? false : 'require';
}

// Postgres OIDs for date, timestamp, and timestamptz.
const DATE_OIDS = [1082, 1114, 1184] as const;

export function createDb(url: string) {
  const sql = postgres(url, { ssl: sslFor(url) });

  // drizzle() MUTATES the client we hand it: it overwrites postgres.js's serializers for
  // the date/time and json OIDs with an identity function, because drizzle converts those
  // values itself before they reach the driver.
  //
  // We hand back that same client for raw `sql` queries, and those pass real Dates. With
  // the serializer neutered, a Date reaches Buffer.byteLength() unserialized and throws
  // `The "string" argument must be of type string ... Received an instance of Date`. That
  // is what broke creating a ride board in production -- PostgresRideListRepo uses raw
  // `sql` and binds cutoff_at/created_at/updated_at as Dates, and it is the only repo doing
  // so that had no integration test, so nothing caught it.
  //
  // Restore postgres.js's own date serializers. Harmless to drizzle, which by then has
  // already turned its own Dates into ISO strings -- re-serializing one is a no-op.
  const own = { ...sql.options.serializers };
  const db = drizzle(sql, { schema });
  for (const oid of DATE_OIDS) {
    if (own[oid]) sql.options.serializers[oid] = own[oid];
  }
  // NOTE: json (114) and jsonb (3802) are deliberately NOT restored. Drizzle stringifies
  // those itself, so putting JSON.stringify back double-encodes every jsonb write and trips
  // the `sanitized_payload is an object` check constraint. Raw `sql` callers that need to
  // bind an object must stringify it themselves.

  return { sql, db };
}

export type Db = ReturnType<typeof createDb>['db'];
export type Sql = ReturnType<typeof createDb>['sql'];
