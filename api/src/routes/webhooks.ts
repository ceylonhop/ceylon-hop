import { Hono } from 'hono';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { BookingRepo } from '../db/bookingRepo';
import type { PaymentRepo } from '../db/paymentRepo';
import type { PaymentAdapter } from '../adapters/payments';
import type { EmailAdapter } from '../adapters/email';
import type { ConciergeTaskRepo } from '../db/conciergeTaskRepo';
import type { NotificationLogRepo } from '../db/notificationLogRepo';
import type { AlertAdapter } from '../adapters/alerts';
import { sendBookingConfirmation, manageUrl } from '../services/notifications';

export function webhookRoutes(deps: {
  bookings: BookingRepo;
  payments: PaymentRepo;
  adapter: PaymentAdapter;
  email: EmailAdapter;
  conciergeTasks: ConciergeTaskRepo;
  // M17 — optional so existing callers/tests keep working; alerts default to no-op.
  alerts?: AlertAdapter;
  notificationLog?: NotificationLogRepo;
  // Enables POST /webhooks/resend (bounce/complaint alerts). Unset → endpoint 404s.
  resendWebhookSecret?: string;
  // Signs the customer's "manage my booking" link in the confirmation email.
  baseUrl: string;
  linkSecret: string;
}) {
  const { bookings, payments, adapter, email, conciergeTasks, notificationLog, baseUrl, linkSecret } = deps;
  const alerts: AlertAdapter = deps.alerts ?? { send: async () => {} };
  const r = new Hono();

  // 5.3 — payment webhook. Verifies signature, reconciles the amount, marks the payment
  // succeeded and the booking paid — idempotently — then sends the confirmation (5.4).
  // M17: the silent failure paths now raise throttled ops alerts.
  r.post('/payments', async (c) => {
    const event = adapter.parseWebhook(await c.req.text());
    if (!event) {
      void alerts.send({
        severity: 'critical',
        kind: 'payhere_signature',
        title: 'PayHere webhook signature failed',
        body: 'A payment notification arrived with an invalid signature — misconfigured merchant secret or someone probing the endpoint.',
        dedupeKey: new Date().toISOString().slice(0, 10), // one alert per day is enough signal
      });
      return c.json({ error: 'invalid_signature' }, 401);
    }

    const payment = await payments.findByOrderId(event.orderId);
    if (!payment) return c.json({ error: 'unknown_order' }, 404);

    if (event.amount !== payment.amount || event.currency !== payment.currency) {
      void alerts.send({
        severity: 'critical',
        kind: 'payhere_amount',
        title: `PayHere amount mismatch on order ${event.orderId}`,
        body: `expected ${payment.amount} ${payment.currency}, webhook says ${event.amount} ${event.currency}`,
        dedupeKey: event.orderId,
      });
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
        await sendBookingConfirmation(paid, email, { manage: manageUrl(paid, baseUrl, linkSecret) });
        // M17: log the send so the watchdog can spot paid-without-confirmation bookings.
        await notificationLog?.markSent(paid.id, 'confirmation');
      } catch (err) {
        console.error(`confirmation email failed for ${paid.reference}:`, err);
        void alerts.send({
          severity: 'critical',
          kind: 'confirmation_email_failed',
          title: `Confirmation email failed for ${paid.reference}`,
          body: `Booking ${paid.reference} is PAID but the customer got no confirmation. Error: ${err instanceof Error ? err.message : String(err)}`,
          dedupeKey: paid.reference,
        });
      }
    }
    return c.json({ ok: true }, 200);
  });

  // M17 — Resend deliverability webhook (svix-signed). Alerts on bounces/complaints so a
  // customer silently not receiving booking email is no longer invisible. Enabled only
  // when the secret is configured; otherwise the route does not exist (404).
  r.post('/resend', async (c) => {
    const secret = deps.resendWebhookSecret;
    if (!secret) return c.notFound();

    const id = c.req.header('svix-id') ?? '';
    const timestamp = c.req.header('svix-timestamp') ?? '';
    const sigHeader = c.req.header('svix-signature') ?? '';
    const raw = await c.req.text();

    // Reject stale/replayed deliveries (>5 min skew).
    const ts = Number(timestamp);
    if (!id || !Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) {
      return c.json({ error: 'invalid_signature' }, 401);
    }

    // svix scheme: HMAC-SHA256 over "id.timestamp.body" with the base64 key after "whsec_",
    // matched (constant-time) against any "v1,<base64>" entry in the signature header.
    const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
    const expected = createHmac('sha256', key).update(`${id}.${timestamp}.${raw}`).digest();
    const match = sigHeader.split(' ').some((part) => {
      const [version, sig] = part.split(',');
      if (version !== 'v1' || !sig) return false;
      const given = Buffer.from(sig, 'base64');
      return given.length === expected.length && timingSafeEqual(given, expected);
    });
    if (!match) return c.json({ error: 'invalid_signature' }, 401);

    let event: { type?: string; data?: { to?: string[] | string; subject?: string } };
    try {
      event = JSON.parse(raw);
    } catch {
      return c.json({ error: 'invalid_payload' }, 400);
    }

    if (event.type === 'email.bounced' || event.type === 'email.complained') {
      const to = Array.isArray(event.data?.to) ? event.data.to.join(', ') : (event.data?.to ?? 'unknown');
      void alerts.send({
        severity: 'warning',
        kind: 'email_bounce',
        title: `Email ${event.type === 'email.bounced' ? 'bounced' : 'flagged as spam'}: ${to}`,
        body: `to: ${to}\nsubject: ${event.data?.subject ?? '?'}\nevent: ${event.type}`,
        dedupeKey: to,
      });
    }
    return c.body(null, 204);
  });

  return r;
}
