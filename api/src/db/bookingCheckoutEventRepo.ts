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

// The daily digest's payments line: over the bookings whose checkout started (a `checkout`
// that succeeded) since a moment, how each one ended. Each booking lands in exactly one bucket,
// strongest answer first: a PayHere `settled` notify beats `failed` beats `dismissed` (so a
// declined-then-retried-then-paid booking is paid), and a booking PayHere never answered (or
// only answered `pending`) is abandoned. `createRefused` counts create calls refused (4xx) or
// errored (5xx) in the same window — those never reach a booking.
export interface CheckoutSummary {
  started: number;
  paid: number;
  declined: number;
  cancelledAtGateway: number;
  abandoned: number;
  createRefused: number;
}

export interface CheckoutSummaryOptions {
  // Booking ids to leave out entirely — the team's own test bookings (config.TEAM_EMAILS).
  excludeBookingIds?: Iterable<string>;
}

export interface BookingCheckoutEventRepo {
  // Best-effort by contract: call sites fire-and-forget and log a rejection, never await it
  // on the request path.
  record(e: BookingCheckoutEventInput, now?: Date): Promise<void>;
  // Newest first.
  listByBookingId(bookingId: string): Promise<BookingCheckoutEvent[]>;
  // Newest first. For the ops payment lookup (spec 2026-09-26): a notify PayHere sent that we
  // rejected carries the order id but no booking id, so only this finds it. Optional because
  // tests type object-literal fakes against this interface.
  listByOrderId?(orderId: string): Promise<BookingCheckoutEvent[]>;
  summarySince(since: Date, opts?: CheckoutSummaryOptions): Promise<CheckoutSummary>;
}

type SummaryRow = Pick<BookingCheckoutEvent, 'at' | 'action' | 'outcome' | 'bookingId'>;

// Shared by both repos so the in-memory fake and Postgres cannot disagree on the buckets. The
// caller hands it the rows at or after `since` (a day's worth — small).
export function summarizeCheckouts(rows: readonly SummaryRow[], since: Date, opts: CheckoutSummaryOptions = {}): CheckoutSummary {
  const exclude = new Set(opts.excludeBookingIds ?? []);
  const inWindow = rows.filter((r) => r.at.getTime() >= since.getTime());
  const started = new Set<string>();
  for (const r of inWindow) {
    if (r.action === 'checkout' && r.outcome === 'succeeded' && r.bookingId && !exclude.has(r.bookingId)) started.add(r.bookingId);
  }
  const answered = (outcome: CheckoutOutcome) =>
    new Set(inWindow.filter((r) => r.action === 'webhook' && r.outcome === outcome && r.bookingId && started.has(r.bookingId)).map((r) => r.bookingId as string));
  const settled = answered('settled');
  const failed = answered('failed');
  const dismissed = answered('dismissed');
  let paid = 0, declined = 0, cancelledAtGateway = 0, abandoned = 0;
  for (const id of started) {
    if (settled.has(id)) paid++;
    else if (failed.has(id)) declined++;
    else if (dismissed.has(id)) cancelledAtGateway++;
    else abandoned++;
  }
  const createRefused = inWindow.filter((r) => r.action === 'create' && (r.outcome === 'refused' || r.outcome === 'error')).length;
  return { started: started.size, paid, declined, cancelledAtGateway, abandoned, createRefused };
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

  async listByOrderId(orderId: string): Promise<BookingCheckoutEvent[]> {
    return this.rows
      .filter((r) => r.orderId === orderId)
      .sort((a, b) => b.at.getTime() - a.at.getTime())
      .map((r) => ({ ...r }));
  }

  async summarySince(since: Date, opts?: CheckoutSummaryOptions): Promise<CheckoutSummary> {
    return summarizeCheckouts(this.rows, since, opts);
  }

  // Test helper.
  all(): BookingCheckoutEvent[] {
    return this.rows.map((r) => ({ ...r }));
  }
}
