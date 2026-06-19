import 'dotenv/config';
import postgres from 'postgres';

const url = process.env.DATABASE_URL ?? '';
const sql = postgres(url, { ssl: 'require', max: 1 });
const tables = ['customers', 'bookings', 'transfer_request', 'trip_request', 'payments', 'concierge_tasks'];
for (const t of tables) {
  const [{ count }] = await sql`select count(*)::int as count from ${sql(t)}`;
  console.log(`${t.padEnd(18)} ${count} rows`);
}
await sql.end();
