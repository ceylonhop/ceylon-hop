import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { customers, bookings, transferRequests, tripRequests, sharedRequests } from './schema';
import {
  type BookingRepo,
  type NewBooking,
  type Booking,
  BookingNotFoundError,
  generateReference,
} from './bookingRepo';
import { assertTransition, type BookingStatus } from '../domain/status';

type BookingRow = typeof bookings.$inferSelect;

export class PostgresBookingRepo implements BookingRepo {
  constructor(private readonly db: Db) {}

  private async assemble(row: BookingRow): Promise<Booking> {
    const [cust] = await this.db.select().from(customers).where(eq(customers.id, row.customerId));
    const customer = {
      firstName: cust.firstName,
      lastName: cust.lastName,
      email: cust.email,
      whatsapp: cust.whatsapp,
      country: cust.country,
      marketingOptIn: cust.marketingOptIn ?? undefined,
    };
    const base = {
      id: row.id,
      reference: row.reference,
      status: row.status as BookingStatus,
      createdAt: row.createdAt.toISOString(),
      total: row.total,
      amountDueNow: row.amountDueNow, // null on pre-GL-3 rows
      currency: row.currency,
    };
    if (row.mode === 'trip') {
      const [tr] = await this.db
        .select()
        .from(tripRequests)
        .where(eq(tripRequests.bookingId, row.id));
      return {
        ...base,
        mode: 'trip',
        input: {
          stops: tr.stops,
          nights: tr.nights,
          dates: tr.dates ?? undefined,
          pax: tr.pax,
          vehicleType: tr.vehicleType as 'car' | 'van',
          serviceType: tr.serviceType as 'private' | 'chauffeur',
          days: tr.days ?? undefined,
          driverNights: tr.driverNights ?? undefined,
          customer,
        },
      };
    }
    if (row.mode === 'shared') {
      const [sr] = await this.db
        .select()
        .from(sharedRequests)
        .where(eq(sharedRequests.bookingId, row.id));
      return {
        ...base,
        mode: 'shared',
        input: {
          corridorId: sr.corridorId,
          date: sr.date,
          time: sr.time,
          seats: sr.seats,
          customer,
        },
      };
    }
    const [t] = await this.db
      .select()
      .from(transferRequests)
      .where(eq(transferRequests.bookingId, row.id));
    return {
      ...base,
      mode: 'single',
      distanceKm: t.distanceKm ?? undefined,
      durationMin: t.durationMin ?? undefined,
      input: {
        from: t.fromPlace,
        to: t.toPlace,
        date: t.travelDate ?? undefined,
        time: t.travelTime ?? undefined,
        vehicleType: t.vehicleType as 'car' | 'van',
        adults: t.adults,
        children: t.children,
        bags: t.bags,
        customer,
      },
    };
  }

  async create(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<Booking> {
    if (opts?.idempotencyKey) {
      const existing = await this.findByIdempotencyKey(opts.idempotencyKey);
      if (existing) return existing;
    }
    const c = b.input.customer;
    const row = await this.db.transaction(async (tx) => {
      const [cust] = await tx
        .insert(customers)
        .values({
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          whatsapp: c.whatsapp,
          country: c.country,
          marketingOptIn: c.marketingOptIn ?? null,
        })
        .returning();
      const [bk] = await tx
        .insert(bookings)
        .values({
          customerId: cust.id,
          reference: generateReference(),
          status: 'draft',
          mode: b.mode,
          total: b.total,
          amountDueNow: b.amountDueNow,
          currency: b.currency,
          idempotencyKey: opts?.idempotencyKey ?? null,
        })
        .returning();
      if (b.mode === 'trip') {
        const t = b.input;
        await tx.insert(tripRequests).values({
          bookingId: bk.id,
          serviceType: t.serviceType,
          pax: t.pax,
          vehicleType: t.vehicleType,
          stops: t.stops,
          nights: t.nights,
          dates: t.dates ?? null,
          days: t.days ?? null,
          driverNights: t.driverNights ?? null,
        });
      } else if (b.mode === 'shared') {
        const t = b.input;
        await tx.insert(sharedRequests).values({
          bookingId: bk.id,
          corridorId: t.corridorId,
          date: t.date,
          time: t.time,
          seats: t.seats,
        });
      } else {
        const t = b.input;
        await tx.insert(transferRequests).values({
          bookingId: bk.id,
          fromPlace: t.from,
          toPlace: t.to,
          travelDate: t.date ?? null,
          travelTime: t.time ?? null,
          vehicleType: t.vehicleType,
          adults: t.adults,
          children: t.children,
          bags: t.bags,
          distanceKm: b.distanceKm ?? null,
          durationMin: b.durationMin ?? null,
        });
      }
      return bk;
    });
    // assemble after commit so the joined rows are visible
    return this.assemble(row);
  }

  async get(id: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    return row ? this.assemble(row) : null;
  }

  async findByIdempotencyKey(key: string): Promise<Booking | null> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.idempotencyKey, key));
    return row ? this.assemble(row) : null;
  }

  async setStatus(id: string, to: BookingStatus): Promise<Booking> {
    const [row] = await this.db.select().from(bookings).where(eq(bookings.id, id));
    if (!row) throw new BookingNotFoundError(id);
    assertTransition(row.status as BookingStatus, to);
    const [updated] = await this.db
      .update(bookings)
      .set({ status: to })
      .where(eq(bookings.id, id))
      .returning();
    return this.assemble(updated);
  }

  async list(filter?: { status?: BookingStatus }): Promise<Booking[]> {
    const rows = filter?.status
      ? await this.db.select().from(bookings).where(eq(bookings.status, filter.status))
      : await this.db.select().from(bookings);
    return Promise.all(rows.map((r) => this.assemble(r)));
  }
}
