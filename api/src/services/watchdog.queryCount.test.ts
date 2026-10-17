import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from '../db/schema';
import { PostgresBookingRepo } from '../db/postgresBookingRepo';
import { PostgresPaymentRepo } from '../db/postgresPaymentRepo';
import { PostgresNotificationLogRepo } from '../db/postgresNotificationLogRepo';
import { PostgresBookingCheckoutEventRepo } from '../db/postgresBookingCheckoutEventRepo';
import { FakeAlertAdapter } from '../adapters/alerts';
import type { NewBooking } from '../db/bookingRepo';
import { runWatchdog } from './watchdog';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The ~15-min watchdog took 18–20 s on prod (2026-10-13) against a 30 s cron timeout, and grew
// ~0.5 s a day: it asked the database once per paid booking (and once per pending one), and every
// parametrised query costs two round trips from Render to the Mumbai pooler (~110 ms). Paid
// bookings never leave 'paid', so that set only grows. These tests pin the sweep to a fixed number
// of statements however many bookings it reads. Only this client's statements are counted
// (postgres.js `debug` fires once per statement), so other files sharing the database cannot skew it.

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single: NewBooking = {
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
  total: 5000, amountDueNow: 5000, currency: 'USD',
};
const DAY = 86_400_000;
// An ISO string, not a Date: drizzle() replaces postgres.js's Date serializer (see db/client.ts).
const threeDaysAgo = () => new Date(Date.now() - 3 * DAY).toISOString();

describe.skipIf(!TEST_URL)('runWatchdog query count (integration)', () => {
  let statements = 0;
  let sql: postgres.Sql;
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;
  let log: PostgresNotificationLogRepo;
  let checkoutEvents: PostgresBookingCheckoutEventRepo;

  beforeAll(async () => {
    // postgres.js runs a one-off pg_catalog type lookup per pooled connection; that is per
    // connection, not per booking, so it stays out of the count.
    sql = postgres(TEST_URL as string, { debug: (_conn, query) => { if (!query.includes('pg_catalog')) statements += 1; } });
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(db);
    payments = new PostgresPaymentRepo(db);
    log = new PostgresNotificationLogRepo(db);
    checkoutEvents = new PostgresBookingCheckoutEventRepo(db);
  });

  // Days old, so neither lands in an alert window: a quiet sweep, which is what prod ran 795 of 847 times.
  async function backdated(status: 'paid' | 'payment_pending'): Promise<string> {
    const b = await bookings.create(single);
    await sql`update bookings set status = ${status}, created_at = ${threeDaysAgo()}::timestamptz where id = ${b.id}`;
    const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: `O-${randomUUID()}`, amount: 5000, currency: 'USD', idempotencyKey: randomUUID() });
    await checkoutEvents.record({ action: 'checkout', outcome: 'succeeded', source: 'server', bookingId: b.id }, new Date(Date.now() - 3 * DAY));
    if (status === 'paid') {
      await sql`update payments set status = 'succeeded', settlement_source = 'webhook', settled_at = now() where id = ${p.id}`;
      await log.markSent(b.id, 'confirmation');
    }
    return b.id;
  }
  async function manuallySettled(): Promise<string> {
    const b = await bookings.create(single);
    await sql`update bookings set status = 'paid', created_at = ${threeDaysAgo()}::timestamptz where id = ${b.id}`;
    const p = await payments.create({ bookingId: b.id, provider: 'cash', orderId: `M-${randomUUID()}`, amount: 5000, currency: 'USD', idempotencyKey: randomUUID() });
    await payments.markSucceededManually(p.id, { reference: null, settledBy: 'ops@ceylonhop.com' });
    return b.id;
  }
  const seeded = new Set<string>();
  const seedBatch = async (n: number) => {
    for (let i = 0; i < n; i++) {
      seeded.add(await backdated('paid'));
      seeded.add(await backdated('payment_pending'));
      seeded.add(await manuallySettled());
    }
  };
  const sweep = async () => {
    statements = 0;
    const alerts = new FakeAlertAdapter();
    await runWatchdog(new Date(), { bookings, log, alerts, payments, checkoutEvents });
    return { statements, alerts };
  };

  it('reads any number of paid and pending bookings in a fixed number of statements', async () => {
    await seedBatch(2);
    const before = await sweep();
    await seedBatch(6);
    const after = await sweep();

    // Six more paid, six more pending and six more manually settled bookings: the per-booking
    // lookups would add 6 (pending timelines) + 6 (confirmation) + 12 (manual: two ledger kinds)
    // + 6 (manual settlement) = 30 statements. Batched, the count does not move — except that files
    // sharing this database may leave a trip, shared or promo booking in these statuses between the
    // two sweeps, and list() then reads one more table (once, not per booking). Hence < 6, not 0.
    expect(after.statements - before.statements).toBeLessThan(6);
    // Same decisions as before: none of this file's bookings is due an alert (other files' rows may be).
    expect(after.alerts.sent.filter((a) => seeded.has(a.dedupeKey ?? ''))).toEqual([]);
  });

  it('batch reads return only the asked-for bookings’ rows', async () => {
    const paid = await backdated('paid');
    const pending = await backdated('payment_pending');
    const manual = await manuallySettled();
    await log.markSent(pending, 'payment_recovery');

    expect(await log.sentAmong([paid, pending, manual], ['confirmation', 'deposit_received'])).toEqual(new Set([paid]));
    expect(await log.sentAmong([pending], ['payment_recovery'])).toEqual(new Set([pending]));
    expect(await log.sentAmong([], ['confirmation'])).toEqual(new Set());

    expect(await payments.manualSettlementAmong([paid, pending, manual])).toEqual(new Set([manual]));
    expect(await payments.manualSettlementAmong([])).toEqual(new Set());

    const events = await checkoutEvents.listByBookingIds([paid, pending]);
    expect(new Set(events.map((e) => e.bookingId))).toEqual(new Set([paid, pending]));
    expect(await checkoutEvents.listByBookingIds([])).toEqual([]);
  });
});
