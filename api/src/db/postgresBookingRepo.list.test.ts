import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The ops Bookings surface waits on GET /admin/ops/bookings, which reads EVERY queue booking
// through list(). Each round-trip from Render to the Supabase pooler costs ~100 ms
// (/health/deep − /health on prod, 2026-09-22), so a query per booking is the whole
// "takes forever to load" — 100 bookings ≈ 10 s+ before the first row paints. These tests
// pin the query count so the list stays a fixed handful of round-trips however many
// bookings the queue holds. Only this client's statements are counted (postgres.js `debug`
// fires once per statement), so other test files sharing the database cannot skew it.

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single: NewBooking = {
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
  total: 5000, amountDueNow: 5000, currency: 'USD',
};
const trip: NewBooking = {
  mode: 'trip',
  input: { stops: ['Colombo Airport', 'Sigiriya', 'Ella'], nights: [1, 2, 0], pax: 2, vehicleType: 'van', serviceType: 'private', customer },
  total: 12000, amountDueNow: 12000, currency: 'USD',
};
const shared: NewBooking = {
  mode: 'shared',
  input: { corridorId: 'hill-line', date: '2026-07-20', time: '08:00', seats: 2, customer },
  total: 7000, amountDueNow: 7000, currency: 'USD',
};

describe.skipIf(!TEST_URL)('PostgresBookingRepo.list() query count (integration)', () => {
  let statements = 0;
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;

  beforeAll(async () => {
    // postgres.js runs a one-off pg_catalog type lookup the first time each pooled connection
    // is used; that is per connection, not per booking, so it stays out of the count.
    const sql = postgres(TEST_URL as string, { debug: (_conn, query) => { if (!query.includes('pg_catalog')) statements += 1; } });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(db);
    payments = new PostgresPaymentRepo(db);
  });

  it('reads a queue of N bookings across every mode in a fixed number of statements', async () => {
    // Six bookings, two per mode, so a per-row customer or request lookup shows up as 6 or 12
    // extra statements — unmistakable against the bound below.
    for (const b of [single, trip, shared, single, trip, shared]) await bookings.create(b);

    statements = 0;
    const rows = await bookings.list({ status: ['draft'] });

    expect(rows.length).toBeGreaterThanOrEqual(6);
    // bookings + customers + one per request table (transfer / trip / shared) = 5.
    expect(statements).toBeLessThanOrEqual(5);
  });

  it('list() assembles the same booking get() does', async () => {
    const created = await bookings.create(trip);
    const viaGet = await bookings.get(created.id);
    const viaList = (await bookings.list({ status: ['draft'] })).find((b) => b.id === created.id);
    expect(viaList).toEqual(viaGet);
  });

  it('findByBookingIds() fetches every payment for a set of bookings in one statement', async () => {
    const a = await bookings.create(single);
    const b = await bookings.create(single);
    const c = await bookings.create(single);
    const pa = await payments.create({ bookingId: a.id, provider: 'fake', orderId: a.reference, amount: 5000, currency: 'USD', idempotencyKey: `pay-${a.id}` });
    await payments.markSucceeded(pa.id);
    await payments.create({ bookingId: b.id, provider: 'fake', orderId: b.reference, amount: 5000, currency: 'USD', idempotencyKey: `pay-${b.id}` });

    statements = 0;
    const found = await payments.findByBookingIds([a.id, b.id, c.id]);

    expect(statements).toBe(1);
    expect(found.filter((p) => p.bookingId === a.id).map((p) => p.status)).toEqual(['succeeded']);
    expect(found.filter((p) => p.bookingId === b.id).map((p) => p.status)).toEqual(['pending']);
    expect(found.some((p) => p.bookingId === c.id)).toBe(false);
    expect(await payments.findByBookingIds([])).toEqual([]);
  });
});
