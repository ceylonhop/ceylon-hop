import { config as loadEnv } from 'dotenv';
import { createDb } from '../src/db/client';

loadEnv({ path: '.env', quiet: true });

const databaseUrl =
  process.env.PREFLIGHT_USE_TEST_DATABASE === '1'
    ? process.env.DATABASE_URL_TEST
    : process.env.DATABASE_URL;
if (!databaseUrl) {
  throw new Error(
    process.env.PREFLIGHT_USE_TEST_DATABASE === '1'
      ? 'DATABASE_URL_TEST is required'
      : 'DATABASE_URL is required',
  );
}

const { sql } = createDb(databaseUrl);

const checks = {
  bookings_total_nonnegative: () => sql`select count(*)::int as count from bookings where total < 0`,
  bookings_amount_due_now_valid: () => sql`select count(*)::int as count from bookings where amount_due_now is not null and (amount_due_now < 0 or amount_due_now > total)`,
  bookings_currency_supported: () => sql`select count(*)::int as count from bookings where currency not in ('USD')`,
  bookings_mode_valid: () => sql`select count(*)::int as count from bookings where mode not in ('single', 'trip', 'shared')`,
  bookings_status_valid: () => sql`select count(*)::int as count from bookings where status not in ('draft', 'payment_pending', 'awaiting_details', 'paid', 'confirmed', 'in_progress', 'completed', 'cancelled', 'refunded', 'no_show')`,
  payments_amount_positive: () => sql`select count(*)::int as count from payments where amount <= 0`,
  payments_currency_supported: () => sql`select count(*)::int as count from payments where currency not in ('USD')`,
  // Mirrors the live CHECK as widened by migration 0029: the two gateways plus the three
  // out-of-band settlement channels ops records via POST /admin/bookings/:id/mark-paid. Left at
  // the pre-0029 pair, every legitimate cash row reads as incompatible and this tool — the one
  // whose whole job is to report money-constraint violations — false-alarms and exits 1.
  payments_provider_supported: () => sql`select count(*)::int as count from payments where provider not in ('payhere', 'fake', 'cash', 'bank_transfer', 'manual_other')`,
  payments_status_valid: () => sql`select count(*)::int as count from payments where status not in ('pending', 'succeeded', 'failed')`,
  payments_succeeded_settled_at_required: () => sql`select count(*)::int as count from payments where status = 'succeeded' and settled_at is null`,
  payments_succeeded_settlement_source_required: () => sql`select count(*)::int as count from payments where status = 'succeeded' and settlement_source is null`,
  corridor_seat_price_positive: () => sql`select count(*)::int as count from corridor where seat_price <= 0`,
  corridor_seat_capacity_positive: () => sql`select count(*)::int as count from corridor where seat_capacity <= 0`,
  shared_departure_seats_total_positive: () => sql`select count(*)::int as count from shared_departure where seats_total <= 0`,
  shared_departure_seats_booked_valid: () => sql`select count(*)::int as count from shared_departure where seats_booked < 0 or seats_booked > seats_total`,
};

try {
  let incompatible = 0;
  let schemaErrors = 0;
  for (const [name, query] of Object.entries(checks)) {
    try {
      const [{ count }] = await query();
      incompatible += count;
      console.log(`${name}: ${count}`);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      if (code !== '42703' && code !== '42P01') throw error;
      schemaErrors += 1;
      console.log(`${name}: schema_missing`);
    }
  }
  console.log(`total_incompatible_rows: ${incompatible}`);
  console.log(`schema_errors: ${schemaErrors}`);
  if (incompatible > 0 || schemaErrors > 0) process.exitCode = 1;
} finally {
  await sql.end();
}
