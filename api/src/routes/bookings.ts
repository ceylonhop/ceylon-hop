import { Hono } from 'hono';
import { SingleTransferInput } from '../domain/singleTransfer';
import { quoteSingleTransfer } from '../services/pricing';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';

export function bookingRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
}) {
  const { bookings, payments, adapter } = deps;
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

    const params = await adapter.createCheckout({
      orderId: payment.orderId,
      amount: payment.amount,
      currency: payment.currency,
    });
    if (params.amount !== booking.total) {
      return c.json({ error: 'amount_mismatch' }, 409);
    }
    return c.json(params, 200);
  });

  return r;
}
