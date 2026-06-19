import { eq } from 'drizzle-orm';
import type { Db } from './client';
import { customers, bookings, transferRequests } from './schema';
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
    const [tr] = await this.db
      .select()
      .from(transferRequests)
      .where(eq(transferRequests.bookingId, row.id));
    return {
      id: row.id,
      reference: row.reference,
      status: row.status as BookingStatus,
      createdAt: row.createdAt.toISOString(),
      total: row.total,
      currency: row.currency,
      input: {
        from: tr.fromPlace,
        to: tr.toPlace,
        date: tr.travelDate ?? undefined,
        time: tr.travelTime ?? undefined,
        vehicleType: tr.vehicleType as 'car' | 'van',
        adults: tr.adults,
        children: tr.children,
        bags: tr.bags,
        customer: {
          name: cust.name,
          email: cust.email,
          whatsapp: cust.whatsapp,
          country: cust.country,
          marketingOptIn: cust.marketingOptIn ?? undefined,
        },
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
          name: c.name,
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
          total: b.total,
          currency: b.currency,
          idempotencyKey: opts?.idempotencyKey ?? null,
        })
        .returning();
      await tx.insert(transferRequests).values({
        bookingId: bk.id,
        fromPlace: b.input.from,
        toPlace: b.input.to,
        travelDate: b.input.date ?? null,
        travelTime: b.input.time ?? null,
        vehicleType: b.input.vehicleType,
        adults: b.input.adults,
        children: b.input.children,
        bags: b.input.bags,
      });
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
