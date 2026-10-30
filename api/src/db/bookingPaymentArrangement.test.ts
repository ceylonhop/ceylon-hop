// Pay on the day (0077). A booking's payment arrangement may only be set while it is still awaiting
// money, and it is the ONLY thing that lets a booking be confirmed without a payment. Exported so
// postgres.test.ts runs the SAME cases against Postgres: the two repos must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { IllegalTransitionError } from '../domain/status';

const sample = (): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    customer: { firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 6)}@example.com`, whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 34200,
  amountDueNow: 34200,
  currency: 'USD',
});

export function paymentArrangementContract(name: string, make: () => Promise<BookingRepo>): void {
  describe(name, () => {
    it('a new booking has no arrangement', async () => {
      const bookings = await make();
      const b = await bookings.create(sample());
      expect(b.paymentArrangement).toBeNull();
      expect((await bookings.get(b.id))!.paymentArrangement).toBeNull();
    });

    it('sets on_the_day on a payment_pending booking', async () => {
      const bookings = await make();
      const b = await bookings.create(sample());
      await bookings.setStatus(b.id, 'payment_pending');
      expect((await bookings.setPaymentArrangement(b.id, 'on_the_day')).paymentArrangement).toBe('on_the_day');
      expect((await bookings.get(b.id))!.paymentArrangement).toBe('on_the_day');
    });

    it('leaves a booking past payment_pending alone', async () => {
      const bookings = await make();
      const b = await bookings.create(sample());
      await bookings.setStatus(b.id, 'payment_pending');
      await bookings.setStatus(b.id, 'paid');
      expect((await bookings.setPaymentArrangement(b.id, 'on_the_day')).paymentArrangement).toBeNull();
    });

    it('confirms a pay-on-the-day booking straight from payment_pending', async () => {
      const bookings = await make();
      const b = await bookings.create(sample());
      await bookings.setStatus(b.id, 'payment_pending');
      await bookings.setPaymentArrangement(b.id, 'on_the_day');
      expect((await bookings.setStatus(b.id, 'confirmed')).status).toBe('confirmed');
    });

    it('refuses to confirm an ordinary unpaid booking, and leaves it payment_pending', async () => {
      const bookings = await make();
      const b = await bookings.create(sample());
      await bookings.setStatus(b.id, 'payment_pending');
      await expect(bookings.setStatus(b.id, 'confirmed')).rejects.toBeInstanceOf(IllegalTransitionError);
      expect((await bookings.get(b.id))!.status).toBe('payment_pending');
    });
  });
}

paymentArrangementContract('InMemoryBookingRepo payment arrangement', async () => new InMemoryBookingRepo());
