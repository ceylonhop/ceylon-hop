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

  // The ordering that used to slip through: ops takes the cash and marks the booking paid while
  // the customer's PayHere notify is still in flight. Both captures are real, so the second one
  // must still be recorded (refundRepo sums succeeded payments — dropping it would cap the refund
  // below the money actually held), but it must never pass as an ordinary settlement.
  it('flags a second capture on a booking already settled in cash, and still records the money', async () => {
    const f = await fixture();
    const manual = await f.payments.create({
      bookingId: f.booking.id,
      provider: 'cash',
      orderId: `${f.booking.reference}-MANUAL`,
      amount: f.booking.total,
      currency: 'USD',
      idempotencyKey: `manual-paid:${f.booking.id}`,
    });
    await f.payments.markSucceededManually(manual.id, { reference: 'slip-9', settledBy: 'ops@x.com' });
    await f.bookings.setStatus(f.booking.id, 'paid');

    const outcome = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(f.event);

    expect(outcome.kind).toBe('double_capture');
    expect(outcome.payment.status).toBe('succeeded');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(1);
    expect((await f.bookings.get(f.booking.id))?.status).toBe('paid');
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

  // PayHere (2026-09-25): one order_id can carry several attempts, each with its own payment_id
  // and status. A decline from an EARLIER attempt can therefore land after a later attempt was
  // captured. That is history, not a reversal — paging "Payment reversed" for it is a false
  // critical that trains everyone to ignore the real chargeback.
  it('treats a late decline from a different attempt on a settled order as a stale attempt', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    const late = await repo.acceptVerifiedEvent({
      ...f.event,
      providerTxnId: 'PAY-EARLIER',
      status: 'failed',
      providerStatusCode: '-2',
      payloadSha256: 'c'.repeat(64),
      sanitizedPayload: { ...f.event.sanitizedPayload, status_code: '-2' },
    });

    expect(late.kind).toBe('stale_attempt');
    expect(late.payment.status).toBe('succeeded');
    expect(late.booking.status).toBe('paid');
    expect(await f.payments.gatewayPaymentIdFor(f.payment.id)).toBe('PAY-123');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(2);
  });

  it('still reports a reversal when the recorded capture itself reports a non-success', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    const same = await repo.acceptVerifiedEvent({
      ...f.event,
      status: 'failed',
      providerStatusCode: '-2',
      payloadSha256: 'c'.repeat(64),
      sanitizedPayload: { ...f.event.sanitizedPayload, status_code: '-2' },
    });

    expect(same.kind).toBe('reversal');
  });

  it('reports any chargeback as a reversal, whichever attempt it names', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    const chargeback = await repo.acceptVerifiedEvent({
      ...f.event,
      providerTxnId: 'PAY-OTHER',
      status: 'charged_back',
      providerStatusCode: '-3',
      payloadSha256: 'd'.repeat(64),
      sanitizedPayload: { ...f.event.sanitizedPayload, status_code: '-3' },
    });

    expect(chargeback.kind).toBe('reversal');
  });

  // PayHere does not enforce unique order_ids, so a second attempt on the same order can ALSO be
  // captured. Overwriting gateway_payment_id with the second capture used to erase the first one
  // (the one our refund tool can reach), and the booking-already-paid branch then paged the wrong
  // story. Keep the first capture's id, record the event, and report a double capture.
  it('reports a second capture on the same order as a double capture and keeps the first capture id', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    const second = await repo.acceptVerifiedEvent({
      ...f.event,
      providerTxnId: 'PAY-456',
      payloadSha256: 'e'.repeat(64),
    });

    expect(second.kind).toBe('double_capture');
    expect(second).toMatchObject({ firstCaptureTxnId: 'PAY-123' });
    expect(second.payment.status).toBe('succeeded');
    expect(second.booking.status).toBe('paid');
    expect(await f.payments.gatewayPaymentIdFor(f.payment.id)).toBe('PAY-123');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(2);
  });

  // PayHere status 0 = "pending": the money has not moved yet, and may still. Treating it like a
  // decline marked the payment failed and emailed the customer "your payment didn't go through"
  // while the original attempt could still succeed — an invitation to pay twice.
  const pendingOf = (e: VerifiedPaymentEvent, txn = e.providerTxnId): VerifiedPaymentEvent => ({
    ...e,
    providerTxnId: txn,
    status: 'pending',
    providerStatusCode: '0',
    payloadSha256: '0'.repeat(64),
    sanitizedPayload: { ...e.sanitizedPayload, status_code: '0' },
  });

  it('keeps a pending payment pending on a PayHere "pending" notify', async () => {
    const f = await fixture();

    const outcome = await new InMemoryPaymentSettlementRepo(f).acceptVerifiedEvent(pendingOf(f.event));

    expect(outcome.kind).toBe('pending');
    expect(outcome.payment.status).toBe('pending');
    expect(outcome.booking.status).toBe('payment_pending');
    expect(await f.events.listForReconciliation(f.payment.id)).toHaveLength(1);
  });

  it('settles normally when the pending attempt later succeeds', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(pendingOf(f.event));

    const later = await repo.acceptVerifiedEvent(f.event);

    expect(later.kind).toBe('settled');
    expect(later.booking.status).toBe('paid');
  });

  it('never reads a "pending" notify on a captured payment as a reversal', async () => {
    const f = await fixture();
    const repo = new InMemoryPaymentSettlementRepo(f);
    await repo.acceptVerifiedEvent(f.event);

    // Same payment_id as the recorded capture: out-of-order delivery, not money going back.
    const late = await repo.acceptVerifiedEvent(pendingOf(f.event));

    expect(late.kind).toBe('stale_attempt');
    expect(late.payment.status).toBe('succeeded');
    expect(late.booking.status).toBe('paid');
  });
});
