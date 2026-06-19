import { Hono } from 'hono';
import { SingleTransferInput } from '../domain/singleTransfer';
import { TripInput } from '../domain/trip';
import { SharedInput } from '../domain/shared';
import { quoteSingleTransfer, quoteTrip, quoteShared } from '../services/pricing';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { DepartureRepo } from '../db/departureRepo';

export function bookingRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  departures: DepartureRepo;
}) {
  const { bookings, payments, adapter, departures } = deps;
  const r = new Hono();

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

    const { currency, total } = quoteSingleTransfer(parsed.data);
    const booking = await bookings.create(
      { mode: 'single', input: parsed.data, total, currency },
      { idempotencyKey: key },
    );
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

    const { currency, total } = quoteTrip(parsed.data);
    const booking = await bookings.create(
      { mode: 'trip', input: parsed.data, total, currency },
      { idempotencyKey: key },
    );
    return c.json(booking, 201);
  });

  // 10.4 — book a shared seat. Resolve the corridor, price by seats, atomically hold the
  // seats on the departure (409 if sold out), then create the booking.
  r.post('/shared', async (c) => {
    const body = await c.req.json().catch(() => null);
    const parsed = SharedInput.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: 'invalid_request', details: parsed.error.flatten() }, 400);
    }

    const key = c.req.header('Idempotency-Key');
    if (key) {
      const existing = await bookings.findByIdempotencyKey(key);
      if (existing) return c.json(existing, 200);
    }

    const corridor = await departures.getCorridor(parsed.data.corridorId);
    if (!corridor) return c.json({ error: 'unknown_corridor' }, 400);

    const held = await departures.holdSeats({
      corridorId: parsed.data.corridorId,
      date: parsed.data.date,
      time: parsed.data.time,
      seats: parsed.data.seats,
    });
    if (!held) return c.json({ error: 'sold_out' }, 409);

    const { currency, total } = quoteShared(parsed.data.seats, corridor.seatPrice);
    const booking = await bookings.create(
      { mode: 'shared', input: parsed.data, total, currency },
      { idempotencyKey: key },
    );
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
  // equal the booking total — never present a charge that disagrees with the booking.
  r.post('/:id/checkout', async (c) => {
    const booking = await bookings.get(c.req.param('id'));
    if (!booking) return c.json({ error: 'not_found' }, 404);

    const idempotencyKey = `checkout:${booking.id}`;
    let payment = await payments.findByIdempotencyKey(idempotencyKey);
    if (!payment) {
      payment = await payments.create({
        bookingId: booking.id,
        provider: adapter.provider,
        orderId: booking.reference,
        amount: booking.total,
        currency: booking.currency,
        idempotencyKey,
      });
      if (booking.status === 'draft') await bookings.setStatus(booking.id, 'payment_pending');
    }

    const cust = booking.input.customer;
    const [firstName, ...rest] = cust.name.split(' ');
    const params = await adapter.createCheckout({
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
      items: `Ceylon Hop ${booking.reference}`,
      customer: {
        firstName: firstName || 'Guest',
        lastName: rest.join(' ') || '-',
        email: cust.email,
        phone: cust.whatsapp,
        country: cust.country,
      },
    });
    if (params.amount !== booking.total) {
      return c.json({ error: 'amount_mismatch' }, 409);
    }
    return c.json(params, 200);
  });

  return r;
}
