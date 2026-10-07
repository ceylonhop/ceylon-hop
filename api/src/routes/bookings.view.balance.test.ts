import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo } from '../db/bookingRepo';
import { InMemoryPaymentRepo, type PaymentPurpose } from '../db/paymentRepo';
import { signBookingToken } from '../lib/bookingToken';

// Deposits (spec 2026-10-07 §5.3): the customer view reads what is owed from the payment ledger.
const SECRET = 'dev-booking-link-secret-change-me';

async function depositBooking() {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const app = createApp({ bookings, payments });
  const b = await bookings.create({
    mode: 'single',
    total: 20000,
    amountDueNow: 5000,
    currency: 'USD',
    input: {
      from: 'Colombo Airport (CMB)',
      to: 'Kandy',
      vehicleType: 'car',
      adults: 2,
      children: 0,
      bags: 1,
      customer: { firstName: 'Maya', lastName: 'Fernandez', email: 'maya@example.com', whatsapp: '+94771234567', country: 'Spain' },
    },
  });
  await bookings.setStatus(b.id, 'payment_pending');
  await bookings.setStatus(b.id, 'paid');
  const pay = async (purpose: PaymentPurpose, amount: number) => {
    const p = await payments.create({
      bookingId: b.id, provider: 'fake', orderId: `ord-${purpose}`, amount, currency: 'USD',
      idempotencyKey: `${b.id}:${purpose}`, purpose,
    });
    await payments.markSucceeded(p.id);
  };
  const view = async () => (await app.request(`/bookings/view?t=${signBookingToken(b.id, SECRET)}`)).json();
  return { pay, view };
}

describe('GET /bookings/view reads the balance from the ledger', () => {
  it('shows the balance from the ledger and offers it', async () => {
    const { pay, view } = await depositBooking();
    await pay('deposit', 5000);
    expect(await view()).toMatchObject({
      totalCents: 20000, amountDueNowCents: 5000, paidCents: 5000, balanceDueCents: 15000, balancePayable: true,
    });
  });

  it('a fully paid deposit booking owes nothing', async () => {
    const { pay, view } = await depositBooking();
    await pay('deposit', 5000);
    await pay('balance', 15000);
    expect(await view()).toMatchObject({ paidCents: 20000, balanceDueCents: 0, balancePayable: false });
  });
});
