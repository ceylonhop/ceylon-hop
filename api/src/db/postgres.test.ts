import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresConciergeTaskRepo } from './postgresConciergeTaskRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

const sample: NewBooking = {
  mode: 'single',
  input: {
    from: 'Colombo Airport',
    to: 'Ella',
    vehicleType: 'car',
    adults: 2,
    children: 0,
    bags: 2,
    customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000,
  currency: 'USD',
};

// Runs only when a test database is configured (CI provisions an ephemeral Postgres).
describe.skipIf(!TEST_URL)('Postgres repos (integration)', () => {
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;
  let tasks: PostgresConciergeTaskRepo;

  beforeAll(async () => {
    const { db } = createDb(TEST_URL as string);
    await migrate(db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(db);
    payments = new PostgresPaymentRepo(db);
    tasks = new PostgresConciergeTaskRepo(db);
  });

  it('persists and reads back a booking with customer + transfer', async () => {
    const created = await bookings.create(sample);
    const got = await bookings.get(created.id);
    expect(got?.reference).toBe(created.reference);
    expect(got?.input.customer.email).toBe('maya@example.com');
    expect(got?.total).toBe(5000);
    if (got?.mode !== 'single') throw new Error('expected a single-transfer booking');
    expect(got.input.from).toBe('Colombo Airport');
  });

  it('is idempotent on the booking idempotency key', async () => {
    const key = `it-${Date.now()}`;
    const a = await bookings.create(sample, { idempotencyKey: key });
    const b = await bookings.create(sample, { idempotencyKey: key });
    expect(b.id).toBe(a.id);
  });

  it('enforces status transitions', async () => {
    const b = await bookings.create(sample);
    const moved = await bookings.setStatus(b.id, 'payment_pending');
    expect(moved.status).toBe('payment_pending');
    await expect(bookings.setStatus(b.id, 'completed')).rejects.toThrow();
  });

  it('persists a payment and a concierge task', async () => {
    const b = await bookings.create(sample);
    const p = await payments.create({
      bookingId: b.id,
      provider: 'fake',
      orderId: b.reference,
      amount: b.total,
      currency: b.currency,
      idempotencyKey: `pay-${b.id}`,
    });
    expect(p.status).toBe('pending');
    const succeeded = await payments.markSucceeded(p.id);
    expect(succeeded.status).toBe('succeeded');
    expect((await payments.findByOrderId(b.reference))?.id).toBe(p.id);

    await tasks.create({ bookingId: b.id, type: 'confirm_pickup' });
    expect(await tasks.listByBooking(b.id)).toHaveLength(1);
  });
});
