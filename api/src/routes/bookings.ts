import { Hono } from 'hono';
import { SingleTransferInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import { SharedBookingRequest } from '../domain/shared';
import { isoToday, isPastIsoDate, firstPastDate } from '../domain/dateRules';
import {
  priceSingle,
  priceTrip,
  priceShared,
  quoteSingleTransfer,
  quoteTrip,
  type PriceOutcome,
} from '../services/pricing';
import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { DepartureRepo } from '../db/departureRepo';
import type { MapsAdapter, DistanceResult } from '../adapters/maps';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { verifyBookingToken } from '../lib/bookingToken';

// GL-3 — how far the site's quotedTotal may drift from the engine price before ops is
// flagged ($1 absorbs rounding differences, never a real disagreement).
const MISMATCH_TOLERANCE_CENTS = 100;
const UNPRICED_NOTE = 'unpriced booking — distance unresolved, verify price';

// One maps lookup per route pair per request: engine pricing and the M8 enrichment share
// results, so going engine-first doesn't double the billed Google calls.
function memoizeDistance(maps: MapsAdapter): MapsAdapter {
  const cache = new Map<string, Promise<DistanceResult | null>>();
  return {
    provider: maps.provider,
    places: (q) => maps.places(q),
    distance(from, to) {
      const key = `${from}|${to}`;
      let hit = cache.get(key);
      if (!hit) {
        hit = maps.distance(from, to);
        cache.set(key, hit);
      }
      return hit;
    },
  };
}

// What the booking stores, resolved engine-first (GL-3): the engine price wins whenever it
// can price; otherwise the customer's quotedTotal, and as a last resort the placeholder
// quote (API-only callers). Customer bookings currently collect the full amount now.
function resolveTotals(
  outcome: PriceOutcome,
  quotedTotal: number | undefined,
  placeholderTotal: number,
): { total: number; amountDueNow: number; mismatch: boolean; unpriced: boolean } {
  if (outcome.priced) {
    const mismatch =
      quotedTotal !== undefined && Math.abs(quotedTotal - outcome.totalCents) > MISMATCH_TOLERANCE_CENTS;
    return { total: outcome.totalCents, amountDueNow: outcome.amountDueNowCents, mismatch, unpriced: false };
  }
  const total = quotedTotal ?? placeholderTotal;
  return { total, amountDueNow: total, mismatch: false, unpriced: true };
}

// Customer-safe view of a booking (allow-list). Only display fields + first name — never the
// raw id, channel, or contact details — so a forwarded link reveals nothing the confirmation
// email doesn't already. Driver/fulfilment lives in RideOps (not loaded); margin is on quotes.
export interface CustomerBookingView {
  reference: string;
  status: string;
  mode: 'single' | 'trip' | 'shared';
  firstName: string;
  from: string;
  to: string;
  date: string; // ISO date or 'to confirm'
  time: string; // HH:mm or 'to confirm'
  travellers: number;
  bags: number | null;
  vehicleType: string | null;
  currency: string;
  totalCents: number;
  amountDueNowCents: number;
  balanceDueCents: number;
}

export function projectBooking(b: Booking): CustomerBookingView {
  const dueNow = b.amountDueNow ?? b.total;
  const base = {
    reference: b.reference,
    status: b.status,
    mode: b.mode,
    firstName: b.input.customer.firstName,
    currency: b.currency,
    totalCents: b.total,
    amountDueNowCents: dueNow,
    balanceDueCents: Math.max(0, b.total - dueNow),
  };
  if (b.mode === 'single') {
    return {
      ...base,
      from: b.input.from,
      to: b.input.to,
      date: b.input.date ?? 'to confirm',
      time: b.input.time ?? 'to confirm',
      travellers: b.input.adults + b.input.children,
      bags: b.input.bags,
      vehicleType: b.input.vehicleType,
    };
  }
  if (b.mode === 'trip') {
    const stops = b.input.stops;
    return {
      ...base,
      from: stops[0],
      to: stops[stops.length - 1],
      date: b.input.dates?.[0] ?? 'to confirm',
      time: 'to confirm',
      travellers: b.input.pax,
      bags: null,
      vehicleType: b.input.vehicleType,
    };
  }
  // Shared (corridor) bookings store only a corridorId — not from/to strings — and the
  // repo that resolves corridor names (DepartureRepo) isn't loaded here, so the
  // customer-safe view surfaces the fixed pickup/drop-off wording used elsewhere for
  // unresolved fields, plus the date/time the customer picked (SharedInput has both).
  return {
    ...base,
    from: 'Pickup',
    to: 'Drop-off',
    date: b.input.date,
    time: b.input.time,
    travellers: b.input.seats,
    bags: null,
    vehicleType: null,
  };
}

export function bookingRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  departures: DepartureRepo;
  maps: MapsAdapter;
  conciergeTasks: ConciergeTaskRepo;
  linkSecret: string;
}) {
  const { bookings, payments, adapter, departures, maps, conciergeTasks } = deps;
  const r = new Hono();

  // Flag a booking for ops as a follow_up task. Best-effort: the booking is already
  // created, so a task hiccup must never fail the request.
  async function flagForOps(booking: Booking, note: string): Promise<void> {
    try {
      await conciergeTasks.create({ bookingId: booking.id, type: 'follow_up', note });
    } catch (err) {
      console.error(`concierge task failed for ${booking.reference}:`, err);
    }
  }

  async function flagPricing(
    booking: Booking,
    resolved: { mismatch: boolean; unpriced: boolean; total: number },
    quotedTotal: number | undefined,
  ): Promise<void> {
    if (resolved.mismatch) {
      await flagForOps(
        booking,
        `price mismatch ${booking.reference}: site quoted ${quotedTotal}¢, engine priced ${resolved.total}¢`,
      );
    } else if (resolved.unpriced) {
      await flagForOps(booking, UNPRICED_NOTE);
    }
  }

  // 1.4 — create a single-transfer draft. Idempotent on the Idempotency-Key header.
  r.post('/single', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SingleTransferInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    // No past dates — a trip can't be booked for a day that has already passed (Asia/Colombo).
    if (isPastIsoDate(parsed.data.date, isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    // The engine is the pricing truth; the client's quotedTotal is only a fallback.
    const legMaps = memoizeDistance(maps);
    const outcome = await priceSingle(parsed.data, legMaps);
    const resolved = resolveTotals(outcome, parsed.data.quotedTotal, quoteSingleTransfer(parsed.data).total);
    // M8 — enrich with road distance/duration (best-effort; never blocks the booking).
    let distance = null;
    try {
      distance = await legMaps.distance(parsed.data.from, parsed.data.to);
    } catch {
      distance = null;
    }
    const booking = await bookings.create(
      {
        mode: 'single',
        input: parsed.data,
        total: resolved.total,
        amountDueNow: resolved.amountDueNow,
        currency: 'USD',
        distanceKm: distance?.km ?? null,
        durationMin: distance?.durationMin ?? null,
      },
      { idempotencyKey: key },
    );
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(booking, 201);
  });

  // 9.4 — create a multi-stop trip draft (planner / tour hand-off). Same idempotency
  // and pipeline as a single transfer; only the input shape and pricing differ.
  r.post('/trip', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = TripInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    // No past dates — reject if any leg date has already passed (Asia/Colombo).
    if (firstPastDate(parsed.data.dates ?? [], isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    // Engine-first; customer bookings currently collect the full amount now.
    const legMaps = memoizeDistance(maps);
    const outcome = await priceTrip(parsed.data, legMaps);
    const resolved = resolveTotals(
      outcome,
      parsed.data.quotedTotal,
      quoteTrip(parsed.data).total,
    );
    // M8 — total road distance/duration across the trip's legs (best-effort; null if any
    // leg can't be resolved, since a partial sum would understate the trip).
    const stops = parsed.data.stops;
    let tripKm: number | null = 0;
    let tripMin: number | null = 0;
    try {
      for (let i = 0; i < stops.length - 1; i++) {
        const leg = await legMaps.distance(stops[i], stops[i + 1]);
        if (!leg) {
          tripKm = null;
          tripMin = null;
          break;
        }
        tripKm += leg.km;
        tripMin += leg.durationMin;
      }
    } catch {
      tripKm = null;
      tripMin = null;
    }
    const booking = await bookings.create(
      {
        mode: 'trip',
        input: parsed.data,
        total: resolved.total,
        amountDueNow: resolved.amountDueNow,
        currency: 'USD',
        distanceKm: tripKm === null ? null : Math.round(tripKm),
        durationMin: tripMin === null ? null : Math.round(tripMin),
      },
      { idempotencyKey: key },
    );
    await flagPricing(booking, resolved, parsed.data.quotedTotal);
    return c.json(booking, 201);
  });

  // 10.4 — book a shared seat. Resolve the corridor, price by seats, atomically hold the
  // seats on the departure (409 if sold out), then create the booking.
  r.post('/shared', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SharedBookingRequest.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }
    const req = parsed.data;
    // No past dates — a seat can't be booked for a departure that has already passed.
    if (isPastIsoDate(req.date, isoToday())) {
      return c.json({ error: 'date_in_past', message: 'Trip dates cannot be in the past.' }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    const corridor = req.corridorId
      ? await departures.getCorridor(req.corridorId)
      : req.from && req.to
        ? await departures.findCorridorByRoute(req.from, req.to)
        : null;
    if (!corridor) return c.json({ error: 'unknown_corridor' }, 400);

    const held = await departures.holdSeats({
      corridorId: corridor.id,
      date: req.date,
      time: req.time,
      seats: req.seats,
    });
    if (!held) return c.json({ error: 'sold_out' }, 409);

    // GL-3 — the corridor DB price is authoritative; the client's quotedTotal is never
    // stored, only compared and flagged when it disagrees.
    const { currency, totalCents: total, amountDueNowCents: amountDueNow } = priceShared(
      req.seats,
      corridor.seatPrice,
    );
    const input = {
      corridorId: corridor.id,
      date: req.date,
      time: req.time,
      seats: req.seats,
      customer: req.customer,
    };
    const booking = await bookings.create(
      { mode: 'shared', input, total, amountDueNow, currency },
      { idempotencyKey: key },
    );
    if (req.quotedTotal !== undefined && Math.abs(req.quotedTotal - total) > MISMATCH_TOLERANCE_CENTS) {
      await flagForOps(
        booking,
        `price mismatch ${booking.reference}: site quoted ${req.quotedTotal}¢, engine priced ${total}¢`,
      );
    }
    return c.json(booking, 201);
  });

  // 1.5 — view a booking via a signed capability token (customer-facing #2). Replaces the
  // old unauthenticated GET /:id (nothing calls it: the site uses POST /:id/checkout and
  // internal callers use the repo). Returns only a customer-safe projection.
  r.get('/view', async (c) => {
    const id = verifyBookingToken(c.req.query('t'), deps.linkSecret);
    if (!id) return c.json({ error: 'invalid_link' }, 401);
    const booking = await deps.bookings.get(id);
    if (!booking) return c.json({ error: 'not_found' }, 404);
    return c.json(projectBooking(booking), 200);
  });

  // 5.2 — start payment. Creates a pending payment (idempotent per booking), moves the
  // booking to payment_pending, and returns checkout params. The checkout amount must
  // equal what the booking says is due now (currently the full total; pre-GL-3 rows
  // have no amountDueNow and are charged the total) — never present a
  // charge that disagrees with the booking.
  r.post('/:id/checkout', async (c) => {
    const booking = await bookings.get(c.req.param('id'));
    if (!booking) return c.json({ error: 'not_found' }, 404);
    const dueNow = booking.amountDueNow ?? booking.total;

    const idempotencyKey = `checkout:${booking.id}`;
    let payment = await payments.findByIdempotencyKey(idempotencyKey);
    if (!payment) {
      payment = await payments.create({
        bookingId: booking.id,
        provider: adapter.provider,
        orderId: booking.reference,
        amount: dueNow,
        currency: booking.currency,
        idempotencyKey,
      });
      if (booking.status === 'draft') await bookings.setStatus(booking.id, 'payment_pending');
    }

    const cust = booking.input.customer;
    const params = await adapter.createCheckout({
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      items: `Ceylon Hop ${booking.reference}`,
      customer: {
        firstName: cust.firstName,
        lastName: cust.lastName,
        email: cust.email,
        phone: cust.whatsapp,
        country: cust.country,
      },
    });
    if (params.amount !== dueNow) {
      return c.json({ error: 'amount_mismatch' }, 409);
    }
    return c.json(params, 200);
  });

  return r;
}
