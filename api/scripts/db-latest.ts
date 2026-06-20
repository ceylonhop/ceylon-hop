import 'dotenv/config';
import postgres from 'postgres';

const sql = postgres(process.env.DATABASE_URL ?? '', { ssl: 'require', max: 1 });
const rows = await sql`
  select b.reference, b.status, b.mode, b.total, c.first_name, c.last_name, c.email, t.from_place, t.to_place
  from bookings b
  join customers c on c.id = b.customer_id
  left join transfer_request t on t.booking_id = b.id
  order by b.created_at desc limit 1`;
console.log(rows[0]);
await sql.end();
