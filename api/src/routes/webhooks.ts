import { Hono } from 'hono';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { EmailAdapter } from '../adapters/email';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';
import { sendBookingConfirmation } from '../services/notifications';

export function webhookRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  email: EmailAdapter;
  conciergeTasks: ConciergeTaskRepo;
}) {
  const { bookings, payments, adapter, email, conciergeTasks } = deps;
  const r = new Hono();

  // 5.3 — payment webhook. Verifies signature, reconciles the amount, marks the payment
  // succeeded and the booking paid — idempotently — then sends the confirmation (5.4).
  r.post('/payments', async (c) => {
    const event = adapter.parseWebhook(await c.req.text());
    if (!event) return c.json({ error: 'invalid_signature' }, 401);

    const payment = await payments.findByOrderId(event.orderId);
    if (!payment) return c.json({ error: 'unknown_order' }, 404);

    if (event.amount !== payment.amount || event.currency !== payment.currency) {
      return c.json({ error: 'amount_mismatch' }, 400);
    }

    // Idempotent: a duplicate notify for an already-settled payment is a no-op.
    if (payment.status === 'succeeded') return c.json({ ok: true, idempotent: true }, 200);

    if (event.status !== 'succeeded') return c.json({ ok: true, status: 'failed' }, 200);

    await payments.markSucceeded(payment.id);
    const booking = await bookings.get(payment.bookingId);
    if (booking && booking.status === 'payment_pending') {
      const paid = await bookings.setStatus(booking.id, 'paid');
      await conciergeTasks.create({ bookingId: paid.id, type: 'confirm_pickup' });
      // Confirmation email is best-effort: the booking is already paid, so a mail
      // provider hiccup must NOT fail the webhook (which would make PayHere retry).
      try {
        await sendBookingConfirmation(paid, email);
      } catch (err) {
        console.error(`confirmation email failed for ${paid.reference}:`, err);
      }
    }
    return c.json({ ok: true }, 200);
  });

  return r;
}
