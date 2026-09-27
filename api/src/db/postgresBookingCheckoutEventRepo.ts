import { and, desc, eq, gte, inArray } from 'drizzle-orm';
import type { Db } from './client';
import { bookingCheckoutEvents } from './schema';
import {
  summarizeCheckouts,
  toCheckoutEvent,
  type CheckoutSummary,
  type CheckoutSummaryOptions,
  type BookingCheckoutEvent,
  type BookingCheckoutEventInput,
  type BookingCheckoutEventRepo,
  type CheckoutAction,
  type CheckoutEventSource,
  type CheckoutOutcome,
} from './bookingCheckoutEventRepo';

const toEvent = (r: typeof bookingCheckoutEvents.$inferSelect): BookingCheckoutEvent => ({
  ...r,
  action: r.action as CheckoutAction,
  outcome: r.outcome as CheckoutOutcome,
  source: r.source as CheckoutEventSource,
});

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
    return rows.map(toEvent);
  }

  // Served by booking_checkout_event_order_id_idx.
  async listByOrderId(orderId: string): Promise<BookingCheckoutEvent[]> {
    const rows = await this.db
      .select()
      .from(bookingCheckoutEvents)
      .where(eq(bookingCheckoutEvents.orderId, orderId))
      .orderBy(desc(bookingCheckoutEvents.at));
    return rows.map(toEvent);
  }

  // One day of the three actions the summary reads (indexed on `at`), bucketed by the same
  // pure function the in-memory repo uses.
  async summarySince(since: Date, opts?: CheckoutSummaryOptions): Promise<CheckoutSummary> {
    const rows = await this.db
      .select({
        at: bookingCheckoutEvents.at,
        action: bookingCheckoutEvents.action,
        outcome: bookingCheckoutEvents.outcome,
        bookingId: bookingCheckoutEvents.bookingId,
      })
      .from(bookingCheckoutEvents)
      .where(and(gte(bookingCheckoutEvents.at, since), inArray(bookingCheckoutEvents.action, ['create', 'checkout', 'webhook'])));
    return summarizeCheckouts(
      rows.map((r) => ({ ...r, action: r.action as CheckoutAction, outcome: r.outcome as CheckoutOutcome })),
      since,
      opts,
    );
  }
}
