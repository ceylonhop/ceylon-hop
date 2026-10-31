import { describe, it, expect, beforeAll } from 'vitest';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import { eq } from 'drizzle-orm';
import * as schema from './schema';
import { PostgresBookingRepo } from './postgresBookingRepo';
import type { NewBooking } from './bookingRepo';

const TEST_URL = process.env.DATABASE_URL_TEST;
const customer = { firstName: 'Via', lastName: 'Test', email: 'via@example.com', whatsapp: '+94770000001', country: 'LK' };

describe.skipIf(!TEST_URL)('trip_request.through round-trips and derives viaStops (integration)', () => {
  let bookings: PostgresBookingRepo;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  beforeAll(async () => {
    const sql = postgres(TEST_URL as string);
    db = drizzle(sql, { schema });
    await migrate(db, { migrationsFolder: 'drizzle' });
    bookings = new PostgresBookingRepo(db);
  });

  it('stores through, reads it back, and writes one booking_legs row with via_stops', async () => {
    const nb: NewBooking = {
      mode: 'trip', total: 1000, amountDueNow: 1000, currency: 'USD',
      input: { stops: ['Kandy', 'Pinnawala', 'Sigiriya'], nights: [0, 0, 0], pax: 1, vehicleType: 'car', serviceType: 'private', through: [0], customer },
    };
    const created = await bookings.create(nb);
    const back = await bookings.get(created.id);
    expect(back?.mode).toBe('trip');
    expect((back!.input as { through?: number[] }).through).toEqual([0]);
    const legs = await db.select().from(schema.bookingLegs).where(eq(schema.bookingLegs.bookingId, created.id));
    expect(legs).toHaveLength(1);
    expect(legs[0]).toMatchObject({ fromPlace: 'Kandy', toPlace: 'Sigiriya', viaStops: ['Pinnawala'] });
  });

  it('leaves a booking without through byte-identical: no key on read-back', async () => {
    const created = await bookings.create({
      mode: 'trip', total: 1000, amountDueNow: 1000, currency: 'USD',
      input: { stops: ['Kandy', 'Ella'], nights: [0, 0], pax: 1, vehicleType: 'car', serviceType: 'private', customer },
    });
    const back = await bookings.get(created.id);
    expect(back!.input).not.toHaveProperty('through');
  });
});
