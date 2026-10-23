import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import * as schema from './schema';
import { PostgresBookingRepo } from './postgresBookingRepo';
import { seedCorridors } from './postgresDepartureRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
// A random day in 2098 that no other suite books. The local test database is shared and persistent,
// so rows left by earlier runs can land on the same day; the test asserts the increase over a
// baseline read, so leftovers can't skew it.
const DAY = new Date(Date.UTC(2098, 0, 1 + Math.floor(Math.random() * 365))).toISOString().slice(0, 10);
const seat = (time: string, seats: number): NewBooking => ({
  mode: 'shared', input: { corridorId: 'airport-cultural', date: DAY, time, seats, customer },
  total: 2749 * seats, amountDueNow: 2749 * seats, currency: 'USD',
});

describe.skipIf(!TEST_URL)('PostgresBookingRepo.paidSharedSeats (integration)', () => {
  let repo: PostgresBookingRepo;
  beforeAll(async () => {
    const sql = postgres(TEST_URL as string);
    const db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    await seedCorridors(sql);
    repo = new PostgresBookingRepo(db);
  });

  it('sums paid seats by departure and leaves unpaid ones out', async () => {
    const pay = async (b: NewBooking) => {
      const x = await repo.create(b);
      await repo.setStatus(x.id, 'payment_pending');
      return repo.setStatus(x.id, 'paid');
    };
    const byTime = async () => {
      const rows = (await repo.paidSharedSeats(DAY, DAY)).filter((r) => r.corridorId === 'airport-cultural');
      for (const r of rows) expect(r.date).toBe(DAY);
      return new Map(rows.map((r) => [r.time, r.seats]));
    };
    const before = await byTime();
    await pay(seat('07:00', 2));
    await pay(seat('07:00', 1));
    await pay(seat('07:30', 2));
    await repo.create(seat('07:00', 4)); // draft — not counted
    const after = await byTime();
    // Strict equality, not a subtraction: a bigint string from sum() would coerce in a subtraction
    // but fail here (and would concatenate when the domain pools departures).
    expect(after.get('07:00')).toBe((before.get('07:00') ?? 0) + 3);
    expect(after.get('07:30')).toBe((before.get('07:30') ?? 0) + 2);
  });
});
