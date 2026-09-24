import { desc, eq } from 'drizzle-orm';
import type { Db } from './client';
import { bookingCheckoutEvents } from './schema';
import {
  toCheckoutEvent,
  type BookingCheckoutEvent,
  type BookingCheckoutEventInput,
  type BookingCheckoutEventRepo,
  type CheckoutAction,
  type CheckoutEventSource,
  type CheckoutOutcome,
} from './bookingCheckoutEventRepo';

export class PostgresBookingCheckoutEventRepo implements BookingCheckoutEventRepo {
  constructor(private readonly db: Db) {}

  async record(e: BookingCheckoutEventInput, now: Date = new Date()): Promise<void> {
    await this.db.insert(bookingCheckoutEvents).values(toCheckoutEvent(e, now));
  }

  async listByBookingId(bookingId: string): Promise<BookingCheckoutEvent[]> {
    const rows = await this.db
      .select()
      .from(bookingCheckoutEvents)
      .where(eq(bookingCheckoutEvents.bookingId, bookingId))
      .orderBy(desc(bookingCheckoutEvents.at));
    return rows.map((r) => ({
      ...r,
      action: r.action as CheckoutAction,
      outcome: r.outcome as CheckoutOutcome,
      source: r.source as CheckoutEventSource,
    }));
  }
}
