import { and, eq, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { customers, bookings, transferRequests, tripRequests, sharedRequests } from './schema';
import {
  type BookingRepo,
  type NewBooking,
  type Booking,
  type BookingChannel,
  BookingNotFoundError,
  generateReference,
} from './bookingRepo';
import { assertTransition, IllegalTransitionError, type BookingStatus } from '../domain/status';

type BookingRow = typeof bookings.$inferSelect;

// A CH-XXXXX reference collision is a Postgres unique-violation (23505) on a *reference*
// constraint — retry the insert with a fresh reference rather than 500-ing the booking.
const UNIQUE_VIOLATION = '23505';
const MAX_REFERENCE_ATTEMPTS = 5;
function isReferenceCollision(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: unknown; constraint_name?: unknown; constraint?: unknown };
  const constraint = String(e.constraint_name ?? e.constraint ?? '');
  return e.code === UNIQUE_VIOLATION && constraint.includes('reference');
}

export class PostgresBookingRepo implements BookingRepo {
  constructor(private readonly db: Db) {}

  private async assemble(row: BookingRow): Promise<Booking> {
    const [cust] = await this.db.select().from(customers).where(eq(customers.id, row.customerId));
    const customer = {
      firstName: cust.firstName,
      lastName: cust.lastName,
      email: cust.email,
      phoneCountryCode: cust.phoneCountryCode ?? undefined,
      phoneNumber: cust.phoneNumber ?? undefined,
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
      channel: row.channel as BookingChannel,
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
    let lastErr: unknown;
    for (let attempt = 0; attempt < MAX_REFERENCE_ATTEMPTS; attempt++) {
      try {
        // assemble after commit so the joined rows are visible
        return await this.assemble(await this.insertBooking(b, opts));
      } catch (err) {
        // A reference collision rolls back the whole tx (customer insert included), so
        // retrying with a fresh generateReference() is clean — no orphaned customer row.
        if (!isReferenceCollision(err)) throw err;
        lastErr = err;
      }
    }
    throw lastErr;
  }

  private async insertBooking(b: NewBooking, opts?: { idempotencyKey?: string }): Promise<BookingRow> {
    const c = b.input.customer;
    return this.db.transaction(async (tx) => {
      const [cust] = await tx
        .insert(customers)
        .values({
          firstName: c.firstName,
          lastName: c.lastName,
          email: c.email,
          phoneCountryCode: c.phoneCountryCode ?? null,
          phoneNumber: c.phoneNumber ?? null,
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
          channel: b.channel ?? 'website',
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
    const from = row.status as BookingStatus;
    assertTransition(from, to);
    // Compare-and-set: only move the row if it is STILL in `from`, so two concurrent
    // transitions (e.g. a double-cancel) can't both win and double-release seats.
    const [updated] = await this.db
      .update(bookings)
      .set({ status: to })
      .where(and(eq(bookings.id, id), eq(bookings.status, from)))
      .returning();
    if (!updated) {
      const [current] = await this.db.select().from(bookings).where(eq(bookings.id, id));
      throw new IllegalTransitionError((current?.status as BookingStatus) ?? from, to);
    }
    return this.assemble(updated);
  }

  async list(filter?: { status?: BookingStatus | BookingStatus[] }): Promise<Booking[]> {
    let rows: BookingRow[];
    if (!filter?.status) {
      rows = await this.db.select().from(bookings);
    } else if (Array.isArray(filter.status)) {
      rows = await this.db.select().from(bookings).where(inArray(bookings.status, filter.status));
    } else {
      rows = await this.db.select().from(bookings).where(eq(bookings.status, filter.status));
    }
    return Promise.all(rows.map((r) => this.assemble(r)));
  }
}
