import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresRefundRepo } from './postgresRefundRepo';
import { futureIsoDate } from '../testSupport/dates';

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('PostgresRefundRepo.pendingCentsByBookingIds (integration)', () => {
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;
  let refunds: PostgresRefundRepo;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(conn.db);
    payments = new PostgresPaymentRepo(conn.db);
    refunds = new PostgresRefundRepo(conn.db);
  });

  const paid = async () => {
    const b = await bookings.create({
      mode: 'single',
      input: {
        from: 'Colombo Airport (CMB)', to: 'Ella', date: futureIsoDate(30), time: '09:00', vehicleType: 'car',
        adults: 2, children: 0, bags: 2,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 10000, amountDueNow: 10000, currency: 'USD',
    });
    const p = await payments.create({
      bookingId: b.id, provider: 'fake', orderId: b.reference, amount: 10000, currency: 'USD', idempotencyKey: `checkout:${b.id}`,
    });
    await payments.markSucceeded(p.id);
    return b;
  };

  it('sums manual_pending per booking and leaves cancelled requests out', async () => {
    const a = await paid();
    const b = await paid();
    await refunds.request({ bookingId: a.id, amountCents: 1000, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    await refunds.request({ bookingId: a.id, amountCents: 2500, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    const gone = await refunds.request({ bookingId: b.id, amountCents: 4000, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });
    await refunds.cancel({ bookingId: b.id, refundId: gone.id });

    const got = await refunds.pendingCentsByBookingIds([a.id, b.id]);
    expect(got.get(a.id)).toBe(3500);
    expect(got.has(b.id)).toBe(false);
  });
});
