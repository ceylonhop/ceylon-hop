import { beforeAll, describe, expect, it } from 'vitest';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { and, eq } from 'drizzle-orm';
import { createDb, type Db } from './client';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { bookingLegs } from './schema';

// One contract, two implementations: the route tests lean on the in-memory fake, so it must
// refuse and record exactly what Postgres does (spec 2026-10-17 §4).
const TEST_URL = process.env.DATABASE_URL_TEST;
const staff = { type: 'staff' as const, id: 'ops@x.com' };
const MISSING = '00000000-0000-4000-8000-0000000000ff';

function single(date?: string, time?: string): NewBooking {
  return {
    mode: 'single', total: 12100, amountDueNow: 12100, currency: 'USD',
    input: {
      from: 'Colombo Airport', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      ...(date ? { date } : {}), ...(time ? { time } : {}),
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+34600', country: 'ES' },
    },
  };
}

function contract(name: string, make: () => Promise<BookingRepo>) {
  describe(name, () => {
    let repo: BookingRepo;
    beforeAll(async () => { repo = await make(); });

    async function paid(b: NewBooking) {
      const made = await repo.create(b);
      await repo.setStatus(made.id, 'payment_pending');
      await repo.setStatus(made.id, 'paid');
      return made;
    }

    it('fills a blank date and time and records who did it', async () => {
      const b = await paid(single());
      const r = await repo.setSchedule(b.id, { date: '2026-11-04', time: '09:00', expected: { date: null, time: null }, actor: staff });
      expect(r.ok).toBe(true);
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && [got!.input.date, got!.input.time]).toEqual(['2026-11-04', '09:00']);
      const events = await repo.listScheduleEvents(b.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ fromDate: null, fromTime: null, toDate: '2026-11-04', toTime: '09:00', actorType: 'staff', actorId: 'ops@x.com' });
    });

    it('changes a set date when the expected value matches, and can clear the time', async () => {
      const b = await paid(single('2026-11-04', '09:00'));
      const r = await repo.setSchedule(b.id, { date: '2026-11-05', time: null, expected: { date: '2026-11-04', time: '09:00' }, actor: staff });
      expect(r.ok).toBe(true);
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && [got!.input.date, got!.input.time ?? null]).toEqual(['2026-11-05', null]);
    });

    it('refuses a stale edit with the current booking, and writes nothing', async () => {
      const b = await paid(single('2026-11-04', '09:00'));
      const r = await repo.setSchedule(b.id, { date: '2026-12-01', time: '10:00', expected: { date: null, time: null }, actor: staff });
      expect(r).toMatchObject({ ok: false, reason: 'conflict' });
      const got = await repo.get(b.id);
      expect(got!.mode === 'single' && got!.input.date).toBe('2026-11-04');
      expect(await repo.listScheduleEvents(b.id)).toHaveLength(0);
    });

    it('refuses a booking that is not paid or confirmed', async () => {
      const b = await repo.create(single());
      await repo.setStatus(b.id, 'payment_pending');
      const r = await repo.setSchedule(b.id, { date: '2026-11-04', time: null, expected: { date: null, time: null }, actor: staff });
      expect(r).toMatchObject({ ok: false, reason: 'not_editable' });
    });

    it('reports a booking that does not exist', async () => {
      const r = await repo.setSchedule(MISSING, { date: '2026-11-04', time: null, expected: { date: null, time: null }, actor: staff });
      expect(r).toEqual({ ok: false, reason: 'not_found' });
    });
  });
}

contract('InMemoryBookingRepo schedule', async () => new InMemoryBookingRepo());

describe.skipIf(!TEST_URL)('PostgresBookingRepo schedule', () => {
  let db: Db;
  // Outer beforeAll runs before the contract's own, so every test below sees a migrated db.
  beforeAll(async () => {
    const conn = createDb(TEST_URL as string);
    db = conn.db;
    await migrate(conn.db, { migrationsFolder: 'drizzle' });
  });
  contract('PostgresBookingRepo schedule contract', async () => new PostgresBookingRepo(db));

  // The date lives twice for a single transfer (spec §2); the driver-facing legs must move too.
  it('moves the booking leg with the request, in the same write', async () => {
    const repo = new PostgresBookingRepo(db);
    const b = await repo.create(single());
    await repo.setStatus(b.id, 'payment_pending');
    await repo.setStatus(b.id, 'paid');
    await repo.setSchedule(b.id, { date: '2026-11-04', time: '09:00', expected: { date: null, time: null }, actor: staff });
    const [leg] = await db.select().from(bookingLegs).where(and(eq(bookingLegs.bookingId, b.id), eq(bookingLegs.kind, 'leg')));
    expect([leg.travelDate, leg.pickupTime]).toEqual(['2026-11-04', '09:00']);
  });
});
