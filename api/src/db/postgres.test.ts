import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresConciergeTaskRepo } from './postgresConciergeTaskRepo';
import { PostgresDepartureRepo, seedCorridors } from './postgresDepartureRepo';
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
  let departures: PostgresDepartureRepo;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    await seedCorridors(sql);
    bookings = new PostgresBookingRepo(conn.db);
    payments = new PostgresPaymentRepo(conn.db);
    tasks = new PostgresConciergeTaskRepo(conn.db);
    departures = new PostgresDepartureRepo(sql);
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

  it('persists and reads back a multi-stop trip', async () => {
    const trip: NewBooking = {
      mode: 'trip',
      input: {
        stops: ['Colombo Airport', 'Sigiriya', 'Ella'],
        nights: [1, 2, 0],
        dates: ['2026-07-20', '2026-07-22'],
        pax: 2,
        vehicleType: 'van',
        serviceType: 'private',
        customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 12000,
      currency: 'USD',
    };
    const created = await bookings.create(trip);
    const got = await bookings.get(created.id);
    expect(got?.mode).toBe('trip');
    if (got?.mode !== 'trip') throw new Error('expected a trip booking');
    expect(got.input.stops).toEqual(['Colombo Airport', 'Sigiriya', 'Ella']);
    expect(got.input.serviceType).toBe('private');
    expect(got.input.customer.email).toBe('maya@example.com');
    expect(got.total).toBe(12000);
  });

  it('persists and reads back a shared booking', async () => {
    const shared: NewBooking = {
      mode: 'shared',
      input: {
        corridorId: 'hill-line',
        date: '2026-07-20',
        time: '08:00',
        seats: 2,
        customer: { name: 'Maya', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 7000,
      currency: 'USD',
    };
    const created = await bookings.create(shared);
    const got = await bookings.get(created.id);
    expect(got?.mode).toBe('shared');
    if (got?.mode !== 'shared') throw new Error('expected a shared booking');
    expect(got.input.corridorId).toBe('hill-line');
    expect(got.input.seats).toBe(2);
  });

  it('holds seats atomically under real DB concurrency (no oversell)', async () => {
    await sql`
      insert into corridor (id, from_place, to_place, seat_price, seat_capacity)
      values ('cap5', 'A', 'B', 1000, 5)
      on conflict (id) do update set seat_capacity = 5`;
    const date = `c-${Date.now()}`; // a fresh departure each run

    const attempts = Array.from({ length: 20 }, () =>
      departures.holdSeats({ corridorId: 'cap5', date, time: 't', seats: 1 }),
    );
    const held = (await Promise.all(attempts)).filter((r) => r !== null);
    expect(held).toHaveLength(5); // exactly capacity, never more

    const [row] = await sql<
      { seats_booked: number; seats_total: number }[]
    >`select seats_booked, seats_total from shared_departure where corridor_id = 'cap5' and date = ${date} and time = 't'`;
    expect(row.seats_booked).toBe(5);
    expect(row.seats_booked).toBeLessThanOrEqual(row.seats_total);
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
