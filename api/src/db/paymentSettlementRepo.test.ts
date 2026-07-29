import { describe, expect, it } from 'vitest';
import { InMemoryBookingRepo } from './bookingRepo';
import { InMemoryPaymentEventRepo } from './paymentEventRepo';
import { InMemoryPaymentRepo } from './paymentRepo';
import {
  InMemoryPaymentSettlementRepo,
  PaymentSettlementError,
  type SettlementFailurePoint,
} from './paymentSettlementRepo';
import type { VerifiedPaymentEvent } from '../adapters/payments';

async function fixture() {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const events = new InMemoryPaymentEventRepo();
  const booking = await bookings.create({
    mode: 'single',
    input: {
      from: 'Colombo',
      to: 'Kandy',
      vehicleType: 'car',
      adults: 2,
      children: 0,
      bags: 1,
      customer: {
        firstName: 'Maya',
        lastName: 'Silva',
        email: 'maya@example.com',
        whatsapp: '+94770000000',
        country: 'Sri Lanka',
      },
    },
    total: 4_000,
    amountDueNow: 4_000,
    currency: 'USD',
  });
  await bookings.setStatus(booking.id, 'payment_pending');
  const payment = await payments.create({
    bookingId: booking.id,
    provider: 'payhere',
    orderId: booking.reference,
    amount: booking.total,
    currency: booking.currency,
    idempotencyKey: `checkout-${booking.id}`,
  });
  const event: VerifiedPaymentEvent = {
    provider: 'payhere',
    merchantId: '1234567',
    orderId: booking.reference,
    providerTxnId: 'PAY-123',
    amountCents: 4_000,
    currency: 'USD',
    status: 'succeeded',
    providerStatusCode: '2',
    receivedAt: new Date('2026-07-28T12:00:00.000Z'),
    payloadSha256: 'a'.repeat(64),
    sanitizedPayload: { order_id: booking.reference, status_code: '2' },
  };
  return { bookings, payments, events, booking, payment, event };
}

describe('InMemoryPaymentSettlementRepo', () => {
  it.each([
    'after_event_insert',
    'after_payment_update',
    'after_booking_update',
  ] as const)('rolls back every financial write after injected failure at %s, then retries', async (point) => {
    const f = await fixture();
    const broken = new InMemoryPaymentSettlementRepo(f, async (at: SettlementFailurePoint) => {
      if (at === point) throw new Error(`injected_${point}`);
    });

    await expect(broken.acceptVerifiedEvent(f.event)).rejects.toThrow(`injected_${point}`);
    expect((await f.payments.findByOrderId(f.event.orderId))?.status).toBe('pending');
    expect((await f.bookings.get(f.booking.id))?.status).toBe('payment_pending');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(0);

    const retry = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(f.event);
    expect(retry.kind).toBe('settled');
    expect(retry.payment.status).toBe('succeeded');
    expect(retry.booking.status).toBe('paid');
  });

  it('serializes concurrent success notifications into one settlement and one duplicate', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    const outcomes = await Promise.all([
      repo.acceptVerifiedEvent(f.event),
      repo.acceptVerifiedEvent(f.event),
    ]);

    expect(outcomes.map((outcome) => outcome.kind).sort()).toEqual(['duplicate', 'settled']);
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(1);
    expect((await f.payments.findByOrderId(f.event.orderId))?.status).toBe('succeeded');
    expect((await f.bookings.get(f.booking.id))?.status).toBe('paid');
  });

  it('rejects amount or currency mismatch without writing evidence or state', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);

    await expect(
      repo.acceptVerifiedEvent({ ...f.event, amountCents: f.event.amountCents + 1 }),
    ).rejects.toMatchObject({ code: 'amount_mismatch' } satisfies Partial<PaymentSettlementError>);
    await expect(
      repo.acceptVerifiedEvent({ ...f.event, currency: 'EUR' }),
    ).rejects.toMatchObject({ code: 'amount_mismatch' } satisfies Partial<PaymentSettlementError>);
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(0);
    expect((await f.payments.findByOrderId(f.event.orderId))?.status).toBe('pending');
  });

  it('records captured money but preserves a booking cancelled during checkout', async () => {
    const f = await fixture();
    await f.bookings.setStatus(f.booking.id, 'cancelled');

    const outcome = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(f.event);

    expect(outcome.kind).toBe('unexpected_booking_state');
    expect(outcome.payment.status).toBe('succeeded');
    expect(outcome.booking.status).toBe('cancelled');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(1);
  });

  it('repairs a legacy succeeded-payment/pending-booking split on the next verified success', async () => {
    const f = await fixture();
    await f.payments.markSucceeded(f.payment.id);

    const outcome = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(f.event);

    expect(outcome.kind).toBe('settled');
    expect(outcome.booking.status).toBe('paid');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(1);
  });

  it('records and reports a reversal after settlement without changing booking history', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    const reversal = await repo.acceptVerifiedEvent({
      ...f.event,
      status: 'charged_back',
      providerStatusCode: '-3',
      payloadSha256: 'b'.repeat(64),
      sanitizedPayload: { ...f.event.sanitizedPayload, status_code: '-3' },
    });

    expect(reversal.kind).toBe('reversal');
    expect(reversal.payment.status).toBe('succeeded');
    expect(reversal.booking.status).toBe('paid');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(2);
  });
});
