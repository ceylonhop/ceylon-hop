import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { futureIsoDate } from '../testSupport/dates';

const TEST_URL = process.env.DATABASE_URL_TEST;

describe.skipIf(!TEST_URL)('PostgresPaymentRepo.touchAttempt (integration)', () => {
  let payments: PostgresPaymentRepo;
  let bookings: PostgresBookingRepo;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    payments = new PostgresPaymentRepo(conn.db);
    bookings = new PostgresBookingRepo(conn.db);
  });

  it('starts at zero, then counts every checkout and stamps the last one', async () => {
    const booking = await bookings.create({
      mode: 'single',
      input: {
        from: 'Colombo Airport (CMB)', to: 'Ella', date: futureIsoDate(30), time: '09:00', vehicleType: 'car',
        adults: 2, children: 0, bags: 2,
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 12000, amountDueNow: 12000, currency: 'USD',
    });
    const p = await payments.create({
      bookingId: booking.id, provider: 'fake', orderId: booking.reference, amount: 12000, currency: 'USD',
      idempotencyKey: `checkout:${booking.id}`,
    });
    expect(p.attemptCount).toBe(0);
    expect(p.lastAttemptAt).toBeNull();

    const before = Date.now();
    // It answers with the new count (RETURNING), so the caller needs no second read.
    expect(await payments.touchAttempt(p.id)).toBe(1);
    expect(await payments.touchAttempt(p.id)).toBe(2);
    const after = await payments.findByOrderId(booking.reference);
    expect(after!.attemptCount).toBe(2);
    expect(after!.lastAttemptAt!.getTime()).toBeGreaterThanOrEqual(before - 1000);
    // The bookkeeping never touches settlement.
    expect(after!.status).toBe('pending');
  });
});
