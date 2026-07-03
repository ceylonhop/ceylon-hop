import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Sql } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresConciergeTaskRepo } from './postgresConciergeTaskRepo';
import { PostgresDepartureRepo, seedCorridors } from './postgresDepartureRepo';
import { PostgresCoordinatorRepo } from './postgresCoordinatorRepo';
import { PostgresRideOpsRepo } from './postgresRideOpsRepo';
import { PostgresNotificationLogRepo } from './postgresNotificationLogRepo';
import { PostgresQuoteRepo } from './postgresQuoteRepo';
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
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 5000,
  amountDueNow: 5000,
  currency: 'USD',
};

// Runs only when a test database is configured (CI provisions an ephemeral Postgres).
describe.skipIf(!TEST_URL)('Postgres repos (integration)', () => {
  let bookings: PostgresBookingRepo;
  let payments: PostgresPaymentRepo;
  let tasks: PostgresConciergeTaskRepo;
  let departures: PostgresDepartureRepo;
  let coordinators: PostgresCoordinatorRepo;
  let rideOps: PostgresRideOpsRepo;
  let notifLog: PostgresNotificationLogRepo;
  let quotes: PostgresQuoteRepo;
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
    coordinators = new PostgresCoordinatorRepo(conn.db);
    rideOps = new PostgresRideOpsRepo(conn.db);
    notifLog = new PostgresNotificationLogRepo(conn.db);
    quotes = new PostgresQuoteRepo(conn.db);
  });

  it('notification log records sent kinds per booking, idempotently', async () => {
    const b = await bookings.create(sample);
    expect(await notifLog.wasSent(b.id, 'trip_reminder')).toBe(false);
    await notifLog.markSent(b.id, 'trip_reminder');
    expect(await notifLog.wasSent(b.id, 'trip_reminder')).toBe(true);
    expect(await notifLog.wasSent(b.id, 'review_request')).toBe(false);
    await notifLog.markSent(b.id, 'trip_reminder'); // duplicate → no-op via unique constraint
    expect(await notifLog.wasSent(b.id, 'trip_reminder')).toBe(true);
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

  it('defaults channel to website and persists an explicit whatsapp channel', async () => {
    const a = await bookings.create(sample);
    expect(a.channel).toBe('website');
    const b = await bookings.create({ ...sample, channel: 'whatsapp' });
    expect(b.channel).toBe('whatsapp');
    expect((await bookings.get(b.id))?.channel).toBe('whatsapp');
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
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 12000,
      amountDueNow: 12000,
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
        customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
      },
      total: 7000,
      amountDueNow: 7000,
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

  it('releases held seats, flooring at zero (GL-3)', async () => {
    await sql`
      insert into corridor (id, from_place, to_place, seat_price, seat_capacity)
      values ('cap5', 'A', 'B', 1000, 5)
      on conflict (id) do update set seat_capacity = 5`;
    const date = `r-${Date.now()}`; // a fresh departure each run

    await departures.holdSeats({ corridorId: 'cap5', date, time: 't', seats: 4 });
    await departures.releaseSeats({ corridorId: 'cap5', date, time: 't', seats: 2 });
    const [afterRelease] = await sql<
      { seats_booked: number }[]
    >`select seats_booked from shared_departure where corridor_id = 'cap5' and date = ${date} and time = 't'`;
    expect(afterRelease.seats_booked).toBe(2);

    await departures.releaseSeats({ corridorId: 'cap5', date, time: 't', seats: 10 }); // over-release
    const [floored] = await sql<
      { seats_booked: number }[]
    >`select seats_booked from shared_departure where corridor_id = 'cap5' and date = ${date} and time = 't'`;
    expect(floored.seats_booked).toBe(0); // floored, never negative

    // a departure that was never held is a harmless no-op
    await expect(
      departures.releaseSeats({ corridorId: 'cap5', date: `${date}-none`, time: 't', seats: 1 }),
    ).resolves.toBeUndefined();
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

  it('persists a quote with JSONB request/result and patches its status', async () => {
    const saved = await quotes.save({
      product: 'private',
      vehicle: 'car',
      customerName: 'Maya',
      customerContact: '+34600',
      totalCents: 4048,
      currency: 'USD',
      rateCardVersion: '2026-06-28',
      marginCents: 900,
      request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] },
      result: { totalCents: 4048, lineItems: [{ label: 'A → B', amountCents: 4048 }] },
      notes: 'via WhatsApp',
    });
    expect(saved.reference).toMatch(/^Q-/);
    const got = await quotes.get(saved.id);
    expect(got?.totalCents).toBe(4048);
    expect((got?.request as { legs: unknown[] }).legs).toHaveLength(1);
    expect((got?.result as { lineItems: unknown[] }).lineItems).toHaveLength(1);

    const listed = await quotes.list({ product: 'private' });
    expect(listed.some((r) => r.id === saved.id)).toBe(true);

    // to-day-inclusive filter: a same-day date-only "to" must include a quote created
    // right now (regression test for the date-only filter treating "to" as midnight UTC).
    const today = saved.createdAt.toISOString().slice(0, 10);
    const listedByDay = await quotes.list({ from: today, to: today });
    expect(listedByDay.some((r) => r.id === saved.id)).toBe(true);

    const sent = await quotes.patch(saved.id, { status: 'sent' });
    expect(sent?.status).toBe('sent');
    expect(sent?.sentAt).toBeInstanceOf(Date);
    expect(sent?.decidedAt).toBeNull();

    // atomic patch path: moving to a decided status stamps decidedAt exactly once, and a
    // later patch (even to another decided status) must not move it — set-once semantics
    // enforced in a single SQL statement, not a read-then-write race.
    const won = await quotes.patch(saved.id, { status: 'won' });
    expect(won?.status).toBe('won');
    expect(won?.decidedAt).toBeInstanceOf(Date);
    expect(won?.sentAt?.getTime()).toBe(sent?.sentAt?.getTime()); // preserved, not re-stamped

    const decidedAtFirst = won?.decidedAt?.getTime();
    const patchedAgain = await quotes.patch(saved.id, { status: 'lost', lostReason: 'too slow' });
    expect(patchedAgain?.status).toBe('lost');
    expect(patchedAgain?.decidedAt?.getTime()).toBe(decidedAtFirst); // still set-once
    expect(patchedAgain?.lostReason).toBe('too slow');

    expect(await quotes.patch('00000000-0000-0000-0000-000000000000', { status: 'won' })).toBeNull();
  });

  it('persists ops layer: coordinator + ride_ops status/flags', async () => {
    const coord = await coordinators.create({ name: 'Nuwan', whatsapp: '+94770', regions: 'South' });
    expect((await coordinators.get(coord.id))?.name).toBe('Nuwan');

    const b = await bookings.create(sample);
    const created = await rideOps.getOrCreate(b.id);
    expect(created.fulfilmentStatus).toBe('paid');

    const veh = await rideOps.setStatus(b.id, 'vehicle_confirmed');
    expect(veh.vehicleConfirmedAt).toBeTruthy();
    await expect(rideOps.setStatus(b.id, 'completed')).rejects.toThrow(); // guard holds in PG too

    const flagged = await rideOps.setFlags(b.id, { vehiclePhotoReceived: true, opsNotes: 'gate 4421' });
    expect(flagged.vehiclePhotoReceived).toBe(true);
    expect(flagged.opsNotes).toBe('gate 4421');

    expect((await rideOps.listByBookingIds([b.id])).map((r) => r.bookingId)).toEqual([b.id]);
  });
});
