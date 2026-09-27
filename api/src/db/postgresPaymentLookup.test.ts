import { describe, it, expect, beforeAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { createDb } from './client';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { PostgresQuoteRepo } from './postgresQuoteRepo';
import { PostgresNotificationLogRepo } from './postgresNotificationLogRepo';
import { PostgresBookingCheckoutEventRepo } from './postgresBookingCheckoutEventRepo';
import { PostgresPaymentRepo } from './postgresPaymentRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;

// The ops payment lookup's reads (spec 2026-09-26 §7) against a real Postgres: the column
// mapping, the soft-delete filter and the timestamps only exist here. Kept out of postgres.test.ts,
// which other open work edits.

const customer = { firstName: 'Maya', lastName: 'Silva', email: 'lookup@example.com', whatsapp: '+34600000000', country: 'Spain' };
const single: NewBooking = {
  mode: 'single',
  input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer },
  total: 5000, amountDueNow: 5000, currency: 'USD',
};

describe.skipIf(!TEST_URL)('payment lookup reads (Postgres integration)', () => {
  let bookings: PostgresBookingRepo;
  let quotes: PostgresQuoteRepo;
  let notifLog: PostgresNotificationLogRepo;
  let checkoutEvents: PostgresBookingCheckoutEventRepo;
  let payments: PostgresPaymentRepo;

  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(conn.db);
    quotes = new PostgresQuoteRepo(conn.db);
    notifLog = new PostgresNotificationLogRepo(conn.db);
    checkoutEvents = new PostgresBookingCheckoutEventRepo(conn.db);
    payments = new PostgresPaymentRepo(conn.db);
  });

  it('finds a booking by reference, assembled like get(), drafts included', async () => {
    const b = await bookings.create(single);
    const found = await bookings.findByReference(b.reference);
    expect(found).toEqual(await bookings.get(b.id));
    expect(found?.status).toBe('draft');
    expect(await bookings.findByReference('CH-NOPE9')).toBeNull();
  });

  it('lists one person’s bookings through the generated person_key, newest first, assembled like get()', async () => {
    // Unique per run: this database outlives the run, and person_key groups by email.
    const email = `lookup-${randomUUID().slice(0, 8)}@example.com`;
    const as = (e: string): NewBooking => ({ ...single, input: { ...single.input, customer: { ...customer, email: e } } } as NewBooking);
    const first = await bookings.create(as(email));
    const second = await bookings.create(as(`  ${email.toUpperCase()} `));
    await bookings.create(as(`other-${email}`));
    const rows = await bookings.listByPersonKey(email, 10);
    expect(rows.map((r) => r.id)).toEqual([second.id, first.id]);
    expect(rows[1]).toEqual(await bookings.get(first.id));
    expect((await bookings.listByPersonKey(email, 1)).map((r) => r.id)).toEqual([second.id]);
  });

  it('finds a quote by reference and hides a soft-deleted one', async () => {
    const q = await quotes.save({
      product: 'private', vehicle: 'car', customerName: 'Maya', customerContact: '+34600', totalCents: 4048,
      currency: 'USD', rateCardVersion: '2026-06-28', marginCents: 900,
      request: { product: 'private', legs: [{ from: 'A', to: 'B', distanceKm: 80 }] }, result: { totalCents: 4048 },
    });
    expect((await quotes.findByReference(q.reference))?.id).toBe(q.id);
    await quotes.softDelete(q.id, 'f@x.com');
    expect(await quotes.findByReference(q.reference)).toBeNull();
  });

  it('lists a booking’s emails with their sent_at, oldest first', async () => {
    const b = await bookings.create(single);
    const other = await bookings.create(single);
    await notifLog.markSent(b.id, 'payment_failed');
    await notifLog.markSent(b.id, 'payment_recovery');
    await notifLog.markSent(other.id, 'confirmation');
    const rows = await notifLog.listByBookingId(b.id);
    expect(rows.map((r) => r.kind).sort()).toEqual(['payment_failed', 'payment_recovery']);
    for (const r of rows) expect(r.sentAt).toBeInstanceOf(Date);
    expect(rows[0].sentAt.getTime()).toBeLessThanOrEqual(rows[1].sentAt.getTime());
  });

  it('lists checkout-log rows by order id, newest first, including rows with no booking', async () => {
    const orderId = `CH-${randomUUID().slice(0, 8).toUpperCase()}`;
    const t0 = new Date(Date.now() - 60_000);
    await checkoutEvents.record({ action: 'webhook', outcome: 'refused', source: 'server', orderId, reason: 'signature_mismatch', httpStatus: 401 }, t0);
    await checkoutEvents.record({ action: 'checkout', outcome: 'succeeded', source: 'server', bookingId: randomUUID(), orderId, attempt: 1 }, new Date(t0.getTime() + 1000));
    const rows = await checkoutEvents.listByOrderId(orderId);
    expect(rows.map((r) => r.action)).toEqual(['checkout', 'webhook']);
    expect(rows[1]).toMatchObject({ bookingId: null, reason: 'signature_mismatch', httpStatus: 401 });
    expect(rows[1].at).toEqual(t0);
  });

  it('reads a payment’s provenance: created, then settled by hand with who and the reference', async () => {
    const b = await bookings.create(single);
    const p = await payments.create({ bookingId: b.id, provider: 'cash', orderId: `${b.reference}-MANUAL`, amount: 5000, currency: 'USD', idempotencyKey: `manual-paid:${b.id}` });
    const before = await payments.provenanceFor(p.id);
    expect(before).toMatchObject({ settledAt: null, settlementSource: null, settledBy: null, gatewayPaymentId: null });
    expect(before?.createdAt).toBeInstanceOf(Date);
    // Unique per run: (provider, gateway_payment_id) is unique and this database outlives the run.
    const slip = `SLIP-${randomUUID().slice(0, 8)}`;
    await payments.markSucceededManually(p.id, { reference: slip, settledBy: 'f@x.com' });
    const after = await payments.provenanceFor(p.id);
    expect(after).toMatchObject({ settlementSource: 'manual', settledBy: 'f@x.com', gatewayPaymentId: slip });
    expect(after?.settledAt).toBeInstanceOf(Date);
    expect(await payments.provenanceFor(randomUUID())).toBeNull();
  });
});
