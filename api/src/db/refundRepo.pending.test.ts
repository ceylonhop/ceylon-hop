import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo } from './bookingRepo';
import { InMemoryPaymentRepo } from './paymentRepo';
import { InMemoryRefundRepo } from './refundRepo';

async function paidBooking(bookings: InMemoryBookingRepo, payments: InMemoryPaymentRepo, total: number) {
  const b = await bookings.create({
    mode: 'single', total, amountDueNow: total, currency: 'USD',
    input: { from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 1,
      customer: { firstName: 'Maya', lastName: 'Silva', email: 'm@x.com', whatsapp: '+94770000000', country: 'LK' } },
  });
  const p = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: b.reference, amount: total, currency: 'USD', idempotencyKey: `k:${b.id}` });
  await payments.markSucceeded(p.id);
  return b;
}

describe('pendingCentsByBookingIds', () => {
  it('sums only manual_pending requests, per booking, and leaves the rest out', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const a = await paidBooking(bookings, payments, 10000);
    const b = await paidBooking(bookings, payments, 10000);
    const c = await paidBooking(bookings, payments, 10000);
    const ask = (bookingId: string, amountCents: number) =>
      refunds.request({ bookingId, amountCents, currency: 'USD', reason: 'x', requestedBy: 'ops@test' });

    await ask(a.id, 1000);
    await ask(a.id, 2500);
    const cancelled = await ask(b.id, 4000);
    await refunds.cancel({ bookingId: b.id, refundId: cancelled.id });
    const confirmed = await ask(c.id, 500);
    await refunds.confirm({ bookingId: c.id, refundId: confirmed.id, gatewayRef: 'PH-1', confirmedBy: 'founder@test' });

    const got = await refunds.pendingCentsByBookingIds([a.id, b.id, c.id]);
    expect([...got.entries()]).toEqual([[a.id, 3500]]);
  });

  it('answers an empty map for no ids', async () => {
    const bookings = new InMemoryBookingRepo();
    const refunds = new InMemoryRefundRepo(bookings, new InMemoryPaymentRepo());
    expect((await refunds.pendingCentsByBookingIds([])).size).toBe(0);
  });
});

// Add-ons after booking (spec 2026-11-14 §6.1): trip-money rules ignore an add-on payment, but the
// refund ceiling deliberately does not. It asks "what money do we hold on this booking?", and an
// add-on payment is money held: it must be refundable, in full, on its own row.
describe('the refund ceiling counts add-on money', () => {
  it('counts a paid add-on in the ceiling and refunds it on its own payment', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const refunds = new InMemoryRefundRepo(bookings, payments);
    const b = await paidBooking(bookings, payments, 4000);
    const [trip] = await payments.findByBookingId(b.id);
    const addOn = await payments.create({ bookingId: b.id, provider: 'payhere', orderId: `${b.reference}-A1`, amount: 500, currency: 'USD', idempotencyKey: `addon:${b.id}`, purpose: 'add_on' });
    await payments.markSucceeded(addOn.id);
    const ask = (amountCents: number, paymentId: string) =>
      refunds.request({ bookingId: b.id, amountCents, currency: 'USD', reason: 'x', requestedBy: 'founder@test', paymentId });

    expect((await ask(4000, trip!.id)).paymentId).toBe(trip!.id);
    // 4000 + 500 is within what is held only if the add-on's 500 is counted.
    expect((await ask(500, addOn.id)).paymentId).toBe(addOn.id);
    await expect(ask(1, addOn.id)).rejects.toMatchObject({ code: 'refund_exceeds_captured' });
  });
});
