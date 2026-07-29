import { describe, it, expect, beforeAll } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb, type Db, type Sql } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import { PostgresPaymentEventRepo } from './postgresPaymentEventRepo';
import { PostgresPaymentSettlementRepo } from './postgresPaymentSettlementRepo';
import { PostgresConciergeTaskRepo } from './postgresConciergeTaskRepo';
import { PostgresDepartureRepo, seedCorridors } from './postgresDepartureRepo';
import { PostgresRideOpsRepo } from './postgresRideOpsRepo';
import { PostgresNotificationLogRepo } from './postgresNotificationLogRepo';
import { PostgresQuoteRepo } from './postgresQuoteRepo';
import { PostgresAlertLogRepo } from './postgresAlertLogRepo';
import type { NewBooking } from './bookingRepo';
import { PostgresQuoteConversionRepo } from './postgresQuoteConversionRepo';
import { digestAccessToken, fingerprintIntent, type WebQuoteIntent } from '../quote/webQuoteV2';
import { bookings as bookingRows } from './schema';
import { eq } from 'drizzle-orm';

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
  let paymentEvents: PostgresPaymentEventRepo;
  let tasks: PostgresConciergeTaskRepo;
  let departures: PostgresDepartureRepo;
  let rideOps: PostgresRideOpsRepo;
  let notifLog: PostgresNotificationLogRepo;
  let quotes: PostgresQuoteRepo;
  let db: Db;
  let sql: Sql;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.db;
    sql = conn.sql;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    await seedCorridors(sql);
    bookings = new PostgresBookingRepo(conn.db);
    payments = new PostgresPaymentRepo(conn.db);
    paymentEvents = new PostgresPaymentEventRepo(conn.db);
    tasks = new PostgresConciergeTaskRepo(conn.db);
    departures = new PostgresDepartureRepo(sql);
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

  it('alert log: atomic cooldown dedupe + countsSince (M17)', async () => {
    const alerts = new PostgresAlertLogRepo((createDb(TEST_URL as string)).db);
    const key = 'pgtest-' + Date.now(); // unique per run — the shared test DB persists rows
    const t0 = new Date();
    const COOLDOWN = 30 * 60_000;
    expect(await alerts.shouldSend('pg_kind', key, COOLDOWN, t0)).toBe(true);
    expect(await alerts.shouldSend('pg_kind', key, COOLDOWN, new Date(t0.getTime() + 10_000))).toBe(false);
    // past the cooldown → delivers again
    expect(await alerts.shouldSend('pg_kind', key, COOLDOWN, new Date(t0.getTime() + 31 * 60_000))).toBe(true);
    // independent key delivers immediately
    expect(await alerts.shouldSend('pg_kind', key + '-other', COOLDOWN, t0)).toBe(true);
    const counts = await alerts.countsSince(new Date(t0.getTime() - 1000));
    expect(counts['pg_kind']).toBeGreaterThanOrEqual(2);
  });

  it('alert log: rollback frees a failed reservation so the next send retries (BI3)', async () => {
    const alerts = new PostgresAlertLogRepo((createDb(TEST_URL as string)).db);
    const key = 'pgroll-' + Date.now();
    const t0 = new Date();
    const COOLDOWN = 30 * 60_000;
    expect(await alerts.shouldSend('pg_roll', key, COOLDOWN, t0)).toBe(true);
    // wrong reserved-at → no-op, reservation stays (a repeat inside the cooldown is suppressed)
    await alerts.rollback('pg_roll', key, new Date(t0.getTime() - 5));
    expect(await alerts.shouldSend('pg_roll', key, COOLDOWN, new Date(t0.getTime() + 10_000))).toBe(false);
    // correct reserved-at → frees it; a send inside the original cooldown now delivers again
    await alerts.rollback('pg_roll', key, t0);
    expect(await alerts.shouldSend('pg_roll', key, COOLDOWN, new Date(t0.getTime() + 20_000))).toBe(true);
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

  it('is concurrency-safe on the idempotency key: two simultaneous creates yield one booking', async () => {
    // Both inserts race the unique idempotency_key constraint; the loser must catch the
    // violation and return the winner's booking, not 500 (see PostgresBookingRepo.create).
    const key = `it-conc-${Date.now()}`;
    const [a, b] = await Promise.all([
      bookings.create(sample, { idempotencyKey: key }),
      bookings.create(sample, { idempotencyKey: key }),
    ]);
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

  it('stores payment evidence idempotently and permits a later reversal', async () => {
    const b = await bookings.create(sample);
    const payment = await payments.create({
      bookingId: b.id,
      provider: 'payhere',
      orderId: b.reference,
      amount: b.total,
      currency: b.currency,
      idempotencyKey: `evidence-${b.id}`,
    });
    const providerTxnId = `PAY-${payment.id}`;
    const event = {
      paymentId: payment.id,
      provider: 'payhere',
      providerTxnId,
      providerStatusCode: '2',
      normalizedStatus: 'succeeded' as const,
      amount: payment.amount,
      currency: payment.currency,
      payloadSha256: 'a'.repeat(64),
      sanitizedPayload: { order_id: payment.orderId, status_code: '2' },
      receivedAt: new Date('2026-07-28T12:00:00.000Z'),
    };

    const first = await paymentEvents.record(event);
    const retry = await paymentEvents.record(event);
    const reversal = await paymentEvents.record({
      ...event,
      providerStatusCode: '-3',
      normalizedStatus: 'charged_back',
      payloadSha256: 'b'.repeat(64),
      sanitizedPayload: { ...event.sanitizedPayload, status_code: '-3' },
      receivedAt: new Date('2026-07-29T12:00:00.000Z'),
    });

    expect(first.inserted).toBe(true);
    expect(retry).toMatchObject({ inserted: false, event: { id: first.event.id } });
    expect(reversal.inserted).toBe(true);
    expect(await paymentEvents.listForReconciliation(payment.id)).toHaveLength(2);
  });

  it('enforces payment-event money and status constraints in Postgres', async () => {
    const b = await bookings.create(sample);
    const payment = await payments.create({
      bookingId: b.id,
      provider: 'payhere',
      orderId: b.reference,
      amount: b.total,
      currency: b.currency,
      idempotencyKey: `constraints-${b.id}`,
    });
    const base = {
      paymentId: payment.id,
      provider: 'payhere',
      providerTxnId: `PAY-${payment.id}`,
      providerStatusCode: '2',
      normalizedStatus: 'succeeded' as const,
      amount: payment.amount,
      currency: payment.currency,
      payloadSha256: 'c'.repeat(64),
      sanitizedPayload: { order_id: payment.orderId, status_code: '2' },
      receivedAt: new Date(),
    };

    await expect(
      paymentEvents.record({ ...base, providerTxnId: `${base.providerTxnId}-zero`, amount: 0 }),
    ).rejects.toThrow();
    await expect(
      paymentEvents.record({
        ...base,
        providerTxnId: `${base.providerTxnId}-missing-amount`,
        amount: undefined as never,
      }),
    ).rejects.toThrow();
    await expect(
      paymentEvents.record({
        ...base,
        providerTxnId: `${base.providerTxnId}-currency`,
        currency: 'EUR',
      }),
    ).rejects.toThrow();
    await expect(
      paymentEvents.record({
        ...base,
        providerTxnId: `${base.providerTxnId}-status`,
        normalizedStatus: 'unknown' as never,
      }),
    ).rejects.toThrow();
    await expect(
      paymentEvents.record({
        ...base,
        providerTxnId: `${base.providerTxnId}-missing-status`,
        normalizedStatus: undefined as never,
      }),
    ).rejects.toThrow();
  });

  it.each([
    'after_event_insert',
    'after_payment_update',
    'after_booking_update',
  ] as const)('atomically rolls back a settlement failure at %s and permits retry', async (point) => {
    const booking = await bookings.create(sample);
    await bookings.setStatus(booking.id, 'payment_pending');
    const payment = await payments.create({
      bookingId: booking.id,
      provider: 'payhere',
      orderId: booking.reference,
      amount: booking.total,
      currency: booking.currency,
      idempotencyKey: `atomic-${point}-${booking.id}`,
    });
    const event = {
      provider: 'payhere' as const,
      merchantId: '1234567',
      orderId: booking.reference,
      providerTxnId: `PAY-${payment.id}`,
      amountCents: payment.amount,
      currency: payment.currency,
      status: 'succeeded' as const,
      providerStatusCode: '2',
      receivedAt: new Date(),
      payloadSha256: 'd'.repeat(64),
      sanitizedPayload: { order_id: booking.reference, status_code: '2' },
    };
    const broken = new PostgresPaymentSettlementRepo(db, bookings, async (at) => {
      if (at === point) throw new Error(`injected_${point}`);
    });

    await expect(broken.acceptVerifiedEvent(event)).rejects.toThrow(`injected_${point}`);
    expect((await payments.findByOrderId(booking.reference))?.status).toBe('pending');
    expect((await bookings.get(booking.id))?.status).toBe('payment_pending');
    expect(await paymentEvents.listForReconciliation(payment.id)).toHaveLength(0);

    const retried = await new PostgresPaymentSettlementRepo(db, bookings).acceptVerifiedEvent(event);
    expect(retried).toMatchObject({
      kind: 'settled',
      payment: { status: 'succeeded' },
      booking: { status: 'paid' },
    });
  });

  it('settles concurrent verified successes once without split state', async () => {
    const booking = await bookings.create(sample);
    await bookings.setStatus(booking.id, 'payment_pending');
    const payment = await payments.create({
      bookingId: booking.id,
      provider: 'payhere',
      orderId: booking.reference,
      amount: booking.total,
      currency: booking.currency,
      idempotencyKey: `concurrent-${booking.id}`,
    });
    const event = {
      provider: 'payhere' as const,
      merchantId: '1234567',
      orderId: booking.reference,
      providerTxnId: `PAY-${payment.id}`,
      amountCents: payment.amount,
      currency: payment.currency,
      status: 'succeeded' as const,
      providerStatusCode: '2',
      receivedAt: new Date(),
      payloadSha256: 'e'.repeat(64),
      sanitizedPayload: { order_id: booking.reference, status_code: '2' },
    };
    const settlement = new PostgresPaymentSettlementRepo(db, bookings);

    const outcomes = await Promise.all([
      settlement.acceptVerifiedEvent(event),
      settlement.acceptVerifiedEvent(event),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['duplicate', 'settled']);
    expect(await paymentEvents.listForReconciliation(payment.id)).toHaveLength(1);
    expect((await payments.findByOrderId(booking.reference))?.status).toBe('succeeded');
    expect((await bookings.get(booking.id))?.status).toBe('paid');
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

  it('updates a web quote with token/revision compare-and-set and fixed expiry', async () => {
    const expiresAt = new Date('2026-08-04T12:00:00.000Z');
    const accessTokenDigest = 'f'.repeat(64);
    const saved = await quotes.save({
      channel: 'web',
      product: 'private',
      vehicle: 'car',
      totalCents: 4_000,
      currency: 'USD',
      rateCardVersion: 'test-card',
      request: { v: 2, intent: { product: 'private' }, engine: { product: 'private' } },
      result: { totalCents: 4_000 },
      rateCardJson: { version: 'test-card' },
      rateLockedUntil: expiresAt,
      intent: { product: 'private' },
      intentFingerprint: 'a'.repeat(64),
      accessTokenDigest,
    });
    const update = {
      id: saved.id,
      accessTokenDigest,
      expectedRevision: 1,
      now: new Date('2026-07-29T12:00:00.000Z'),
      quote: {
        channel: 'web' as const,
        product: 'private',
        vehicle: 'van',
        totalCents: 5_000,
        currency: 'USD',
        rateCardVersion: 'test-card',
        request: { v: 2, intent: { product: 'private', vehicle: 'van' } },
        result: { totalCents: 5_000 },
        intent: { product: 'private', vehicle: 'van' },
        intentFingerprint: 'b'.repeat(64),
      },
    };

    const outcomes = await Promise.all([
      quotes.updateWebV2(update),
      quotes.updateWebV2(update),
    ]);
    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['stale_revision', 'updated']);
    const current = await quotes.get(saved.id);
    expect(current).toMatchObject({
      revision: 2,
      totalCents: 5_000,
      rateLockedUntil: expiresAt,
    });
  });

  async function lockedWebQuote(token: string) {
    const intent: WebQuoteIntent = {
      product: 'private',
      routeId: `integration-${Date.now()}-${Math.random()}`,
      vehicle: 'car',
      pax: 2,
      bags: 1,
      date: '2026-09-10',
      time: '09:00',
      legs: [{ from: 'Kandy', to: 'Nanu Oya' }],
      extras: [],
    };
    const rateCardVersion = 'conversion-integration-v1';
    const result = {
      product: 'private',
      currency: 'USD',
      lineItems: [{ label: 'Private transfer', amountCents: 12_345 }],
      subtotalCents: 12_345,
      totalCents: 12_345,
      priceAdjustmentCents: 0,
      priceStrategy: 'none',
      depositCents: 12_345,
      amountDueNowCents: 12_345,
      marginEstimateCents: null,
      rateCardVersion,
      warnings: [],
    };
    const quote = await quotes.save({
      channel: 'web',
      product: 'private',
      vehicle: 'car',
      totalCents: result.totalCents,
      currency: result.currency,
      rateCardVersion,
      request: {
        v: 2,
        intent,
        engine: {
          product: 'private',
          vehicle: 'car',
          pax: 2,
          bags: 1,
          legs: [{ from: 'Kandy', to: 'Nanu Oya', distanceKm: 78 }],
          extras: [],
        },
      },
      result,
      rateCardJson: { version: rateCardVersion },
      rateLockedUntil: new Date('2026-10-01T00:00:00.000Z'),
      intent,
      intentFingerprint: fingerprintIntent(intent),
      accessTokenDigest: digestAccessToken(token),
    });
    return {
      quote,
      request: {
        quoteId: quote.id,
        accessToken: token,
        revision: quote.revision,
        intent,
        bookingDetails: {
          customer: sample.input.customer,
          date: intent.date,
          time: intent.time,
        },
      },
    };
  }

  it('atomically converts one Postgres quote under concurrent double-submit', async () => {
    const locked = await lockedWebQuote(`concurrent-${Date.now()}`);
    const converter = new PostgresQuoteConversionRepo(
      db,
      bookings,
      () => new Date('2026-09-01T00:00:00.000Z'),
    );
    const [first, second] = await Promise.all([
      converter.convert(locked.request),
      converter.convert(locked.request),
    ]);
    expect([first.replay, second.replay].sort()).toEqual([false, true]);
    expect(first.booking.id).toBe(second.booking.id);
    const saved = await quotes.get(locked.quote.id);
    expect(saved).toMatchObject({ status: 'won', convertedBookingId: first.booking.id });

    const [stored] = await db
      .select({
        subtotal: bookingRows.subtotal,
        discountTotal: bookingRows.discountTotal,
        pricingSnapshot: bookingRows.pricingSnapshotJson,
      })
      .from(bookingRows)
      .where(eq(bookingRows.id, first.booking.id));
    expect(stored).toMatchObject({
      subtotal: 12_345,
      discountTotal: 0,
      pricingSnapshot: {
        quoteId: locked.quote.id,
        totalCents: 12_345,
        amountDueNowCents: 12_345,
      },
    });
  });

  it.each(['after_booking_insert', 'after_quote_update'] as const)(
    'rolls back the Postgres transaction on %s and permits retry',
    async (failurePoint) => {
      const locked = await lockedWebQuote(`rollback-${failurePoint}-${Date.now()}`);
      const failing = new PostgresQuoteConversionRepo(
        db,
        bookings,
        () => new Date('2026-09-01T00:00:00.000Z'),
        (point) => {
          if (point === failurePoint) throw new Error(`injected:${point}`);
        },
      );
      await expect(failing.convert(locked.request)).rejects.toThrow(`injected:${failurePoint}`);
      expect(await bookings.findByIdempotencyKey(`quote-v2:${locked.quote.id}`)).toBeNull();
      expect((await quotes.get(locked.quote.id))?.convertedBookingId).toBeNull();

      const retry = await new PostgresQuoteConversionRepo(
        db,
        bookings,
        () => new Date('2026-09-01T00:00:00.000Z'),
      ).convert(locked.request);
      expect(retry.replay).toBe(false);
      expect((await quotes.get(locked.quote.id))?.convertedBookingId).toBe(retry.booking.id);
    },
  );

  it('persists ops layer: ride_ops status/flags', async () => {
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

  it('derives routeText from request_json legs in the list projection', async () => {
    const saved = await quotes.save({
      product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD',
      rateCardVersion: 'test',
      request: { tool: { legs: [{ from: 'Colombo', to: 'Kandy' }, { from: 'Kandy', to: 'Ella' }] } },
      result: {},
    });
    const listed = await quotes.list({});
    expect(listed.find((r) => r.id === saved.id)?.routeText).toBe('Colombo · Kandy · Ella');
  });
});
