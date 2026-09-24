import { randomUUID } from 'node:crypto';

// ============================================================================
// Booking checkout attempt log — one append-only row per thing that happened on the way from
// "create" to "settled", whatever the outcome. bookings / payments hold only where things ENDED
// UP (and a retry reuses the payment row), so a customer who reached PayHere twice and pressed
// "Try again" twice left no trace of what they saw (audit 2026-09-24, CH-8UVYG). Same stance as
// the Ride Board's ride_board_event.
//
// Writing to it is best-effort: a booking or a payment must never fail because the log did.
// ============================================================================

export type CheckoutAction =
  | 'create' // POST /bookings/single|trip|shared
  | 'checkout' // POST /bookings/:id/checkout — a payment attempt was started
  | 'gateway' // what the PayHere SDK reported in the browser (client beacon)
  | 'webhook' // what PayHere's notify said
  | 'return'; // what GET /bookings/pay-return answered the page

export type CheckoutOutcome =
  | 'succeeded' // create 201 / checkout 200
  | 'refused' // a 4xx                                            (reason = error code)
  | 'error' // a 5xx, or the SDK's onError                        (reason = its message)
  | 'opened' // the SDK was handed the payment
  | 'dismissed' // the customer closed the gateway (SDK onDismissed, notify -1)
  | 'failed' // notify -2 / return answered failed
  | 'settled' // notify 2 / return answered paid
  | 'pending'; // notify 0 / return answered pending

export type CheckoutEventSource = 'server' | 'client';

export const CHECKOUT_REASON_MAX = 200;
export const CHECKOUT_UA_MAX = 300;

export interface BookingCheckoutEventInput {
  action: CheckoutAction;
  outcome: CheckoutOutcome;
  source: CheckoutEventSource;
  bookingId?: string | null;
  reference?: string | null;
  orderId?: string | null;
  channel?: string | null;
  reason?: string | null;
  httpStatus?: number | null;
  attempt?: number | null;
  ua?: string | null;
}

export interface BookingCheckoutEvent {
  id: string;
  at: Date;
  action: CheckoutAction;
  outcome: CheckoutOutcome;
  source: CheckoutEventSource;
  bookingId: string | null;
  reference: string | null;
  orderId: string | null;
  channel: string | null;
  reason: string | null;
  httpStatus: number | null;
  attempt: number | null;
  ua: string | null;
}

export interface BookingCheckoutEventRepo {
  // Best-effort by contract: call sites fire-and-forget and log a rejection, never await it
  // on the request path.
  record(e: BookingCheckoutEventInput, now?: Date): Promise<void>;
  // Newest first.
  listByBookingId(bookingId: string): Promise<BookingCheckoutEvent[]>;
}

const clip = (v: string | null | undefined, max: number): string | null =>
  v == null || v === '' ? null : v.slice(0, max);

export function toCheckoutEvent(e: BookingCheckoutEventInput, now: Date): BookingCheckoutEvent {
  return {
    id: randomUUID(),
    at: now,
    action: e.action,
    outcome: e.outcome,
    source: e.source,
    bookingId: e.bookingId ?? null,
    reference: e.reference ?? null,
    orderId: e.orderId ?? null,
    channel: e.channel ?? null,
    reason: clip(e.reason, CHECKOUT_REASON_MAX),
    httpStatus: e.httpStatus ?? null,
    attempt: e.attempt ?? null,
    ua: clip(e.ua, CHECKOUT_UA_MAX),
  };
}

// The one way a route writes the log: never awaited, never thrown. A missing repo (tests, a
// caller that opted out) records nothing; a failing one logs and the request never notices.
export function recordCheckoutEvent(repo: BookingCheckoutEventRepo | undefined, e: BookingCheckoutEventInput): void {
  if (!repo) return;
  try {
    repo.record(e).catch((err: unknown) => console.error('booking_checkout_event_failed', err));
  } catch (err) {
    console.error('booking_checkout_event_failed', err);
  }
}

export class InMemoryBookingCheckoutEventRepo implements BookingCheckoutEventRepo {
  private readonly rows: BookingCheckoutEvent[] = [];

  // Synchronous push: callers fire-and-forget, and tests read the log right after the response.
  record(e: BookingCheckoutEventInput, now: Date = new Date()): Promise<void> {
    this.rows.push(toCheckoutEvent(e, now));
    return Promise.resolve();
  }

  async listByBookingId(bookingId: string): Promise<BookingCheckoutEvent[]> {
    return this.rows
      .filter((r) => r.bookingId === bookingId)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((r) => ({ ...r }));
  }

  // Test helper.
  all(): BookingCheckoutEvent[] {
    return this.rows.map((r) => ({ ...r }));
  }
}
