import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? '';
const sql = postgres(url, { ssl: 'require', max: 1 });
const rows = await sql`
  select table_name from information_schema.tables
  where table_schema = 'public' order by table_name`;
console.log(
  'public tables:',
  rows.map((r) => r.table_name),
);
await sql.end();
