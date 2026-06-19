import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL is not set (api/.env)');
  process.exit(1);
}

const sql = postgres(url, { ssl: 'require', max: 1 });
const rows = await sql`select 1 as ok, current_database() as db`;
console.log('connected:', rows[0]);
await sql.end();
