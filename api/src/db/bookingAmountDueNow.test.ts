// refreshPayerDetails may rewrite amount_due_now (the customer switched deposit ↔ full on the pay
// link) ONLY while the booking can still be charged and nothing on it has succeeded (spec
// 2026-10-07 §4, rev. 2026-10-08). Exported so postgres.test.ts runs the SAME cases against
// Postgres: the SQL guard and the in-memory one must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './paymentRepo';

export interface AmountDueEnv { bookings: BookingRepo; payments: PaymentRepo }

const TOTAL = 21900;
const DEPOSIT = 5000;

const sample = (): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 6)}@example.com`, whatsapp: '+34600000000', country: 'Spain' },
  },
  total: TOTAL,
  amountDueNow: DEPOSIT,
  currency: 'USD',
});

export function amountDueNowContract(name: string, make: () => Promise<AmountDueEnv>): void {
  describe(name, () => {
    async function setup() {
      const env = await make();
      const booking = await env.bookings.create(sample());
      const details = (amountDueNow?: number) => ({ customer: booking.input.customer, amountDueNow });
      return { env, booking, details };
    }

    it('rewrites amountDueNow on a draft booking', async () => {
      const { env, booking, details } = await setup();
      expect(booking.status).toBe('draft');
      const out = await env.bookings.refreshPayerDetails(booking.id, details(TOTAL));
      expect(out.amountDueNow).toBe(TOTAL);
      expect((await env.bookings.get(booking.id))!.amountDueNow).toBe(TOTAL);
    });

    it('rewrites it on a payment_pending booking, in both directions', async () => {
      const { env, booking, details } = await setup();
      await env.bookings.setStatus(booking.id, 'payment_pending');
      expect((await env.bookings.refreshPayerDetails(booking.id, details(TOTAL))).amountDueNow).toBe(TOTAL);
      expect((await env.bookings.refreshPayerDetails(booking.id, details(DEPOSIT))).amountDueNow).toBe(DEPOSIT);
    });

    it('leaves it alone when no amountDueNow is passed (ops re-book)', async () => {
      const { env, booking, details } = await setup();
      const out = await env.bookings.refreshPayerDetails(booking.id, details());
      expect(out.amountDueNow).toBe(DEPOSIT);
    });

    it('does not rewrite it once a payment on the booking has succeeded, even if the status lags', async () => {
      const { env, booking, details } = await setup();
      await env.bookings.setStatus(booking.id, 'payment_pending');
      const p = await env.payments.create({
        bookingId: booking.id, provider: 'fake', orderId: `${booking.reference}-D`, amount: DEPOSIT,
        currency: 'USD', idempotencyKey: `checkout:${booking.id}:deposit`, purpose: 'deposit',
      });
      await env.payments.markSucceeded(p.id);
      const out = await env.bookings.refreshPayerDetails(booking.id, details(TOTAL));
      expect(out.amountDueNow).toBe(DEPOSIT);
      expect((await env.bookings.get(booking.id))!.amountDueNow).toBe(DEPOSIT);
    });

    it('a failed or pending attempt does not freeze it', async () => {
      const { env, booking, details } = await setup();
      await env.bookings.setStatus(booking.id, 'payment_pending');
      const p = await env.payments.create({
        bookingId: booking.id, provider: 'fake', orderId: `${booking.reference}-D`, amount: DEPOSIT,
        currency: 'USD', idempotencyKey: `checkout:${booking.id}:deposit`, purpose: 'deposit',
      });
      await env.payments.markFailed(p.id);
      expect((await env.bookings.refreshPayerDetails(booking.id, details(TOTAL))).amountDueNow).toBe(TOTAL);
    });

    it('does not rewrite it on a booking past payment_pending', async () => {
      const { env, booking, details } = await setup();
      await env.bookings.setStatus(booking.id, 'payment_pending');
      await env.bookings.setStatus(booking.id, 'paid');
      const out = await env.bookings.refreshPayerDetails(booking.id, details(TOTAL));
      expect(out.amountDueNow).toBe(DEPOSIT);
    });
  });
}

amountDueNowContract('InMemoryBookingRepo amount_due_now guard', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  bookings.attachPayments(payments);
  return { bookings, payments };
});
