import { Hono } from 'hono';
import { SingleTransferInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import { SharedBookingRequest } from '../domain/shared';
import {
  priceSingle,
  priceTrip,
  priceShared,
  quoteSingleTransfer,
  quoteTrip,
  type PriceOutcome,
} from '../services/pricing';
import { depositCents } from '../quote/extrasDeposit';
import type { BookingRepo, Booking } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { DepartureRepo } from '../db/departureRepo';
import type { MapsAdapter } from '../adapters/maps';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';

// GL-3 — how far the site's quotedTotal may drift from the engine price before ops is
// flagged ($1 absorbs rounding differences, never a real disagreement).
const MISMATCH_TOLERANCE_CENTS = 100;
const UNPRICED_NOTE = 'unpriced booking — distance unresolved, verify price';

// What the booking stores, resolved engine-first (GL-3): the engine price wins whenever it
// can price; otherwise the customer's quotedTotal, and as a last resort the placeholder
// quote (API-only callers). Chauffeur trips only collect the deposit now, whatever priced.
function resolveTotals(
  outcome: PriceOutcome,
  quotedTotal: number | undefined,
  placeholderTotal: number,
  chauffeur: boolean,
): { total: number; amountDueNow: number; mismatch: boolean; unpriced: boolean } {
  if (outcome.priced) {
    const mismatch =
      quotedTotal !== undefined && Math.abs(quotedTotal - outcome.totalCents) > MISMATCH_TOLERANCE_CENTS;
    return { total: outcome.totalCents, amountDueNow: outcome.amountDueNowCents, mismatch, unpriced: false };
  }
  const total = quotedTotal ?? placeholderTotal;
  return { total, amountDueNow: chauffeur ? depositCents(total) : total, mismatch: false, unpriced: true };
}

export function bookingRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  departures: DepartureRepo;
  maps: MapsAdapter;
  conciergeTasks: ConciergeTaskRepo;
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

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    // GL-3 — the engine is the pricing truth; the client's quotedTotal is only a fallback.
    const outcome = await priceSingle(parsed.data, maps);
    const resolved = resolveTotals(outcome, parsed.data.quotedTotal, quoteSingleTransfer(parsed.data).total, false);
    // M8 — enrich with road distance/duration (best-effort; never blocks the booking).
    let distance = null;
    try {
      distance = await maps.distance(parsed.data.from, parsed.data.to);
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

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    // GL-3 — engine-first; chauffeur trips only collect the deposit now (10%, $50 cap).
    const outcome = await priceTrip(parsed.data, maps);
    const resolved = resolveTotals(
      outcome,
      parsed.data.quotedTotal,
      quoteTrip(parsed.data).total,
      parsed.data.serviceType === 'chauffeur',
    );
    // M8 — total road distance/duration across the trip's legs (best-effort; null if any
    // leg can't be resolved, since a partial sum would understate the trip).
    const stops = parsed.data.stops;
    let tripKm: number | null = 0;
    let tripMin: number | null = 0;
    try {
      for (let i = 0; i < stops.length - 1; i++) {
        const leg = await maps.distance(stops[i], stops[i + 1]);
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

  // 1.5 — read a booking back.
  r.get('/:id', async (c) => {
    const booking = await bookings.get(c.req.param('id'));
    if (!booking) return c.json({ error: 'not_found' }, 404);
    return c.json(booking, 200);
  });

  // 5.2 — start payment. Creates a pending payment (idempotent per booking), moves the
  // booking to payment_pending, and returns checkout params. The checkout amount must
  // equal what the booking says is due now (GL-3: the chauffeur deposit, else the total;
  // pre-GL-3 rows have no amountDueNow and are charged the total) — never present a
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
