import { describe, expect, it } from 'vitest';
import {
  InMemoryPaymentEventRepo,
  type NewPaymentEvent,
} from './paymentEventRepo';
import { InMemoryPaymentRepo } from './paymentRepo';

const receivedAt = new Date('2026-07-28T12:00:00.000Z');

const succeeded: NewPaymentEvent = {
  paymentId: 'payment-1',
  provider: 'payhere',
  providerTxnId: 'PAY-123',
  providerStatusCode: '2',
  normalizedStatus: 'succeeded',
  amount: 4_000,
  currency: 'USD',
  payloadSha256: 'a'.repeat(64),
  sanitizedPayload: {
    order_id: 'CH-ABC12',
    payment_id: 'PAY-123',
    payhere_amount: '40.00',
    payhere_currency: 'USD',
    status_code: '2',
  },
  receivedAt,
};

describe('InMemoryPaymentEventRepo', () => {
  it('records and selects an immutable payment event for reconciliation', async () => {
    const repo = new InMemoryPaymentEventRepo();
    const recorded = await repo.record(succeeded);

    expect(recorded.inserted).toBe(true);
    expect(recorded.event).toMatchObject(succeeded);
    expect(recorded.event.id).toBeTruthy();
    expect(await repo.listForReconciliation(succeeded.paymentId)).toEqual([recorded.event]);
  });

  it('treats an exact provider event retry as idempotent', async () => {
    const repo = new InMemoryPaymentEventRepo();
    const first = await repo.record(succeeded);
    const retry = await repo.record({ ...succeeded, sanitizedPayload: { ...succeeded.sanitizedPayload } });

    expect(retry.inserted).toBe(false);
    expect(retry.event.id).toBe(first.event.id);
    expect(await repo.listForReconciliation(succeeded.paymentId)).toHaveLength(1);
  });

  it('records a later reversal for the same provider transaction', async () => {
    const repo = new InMemoryPaymentEventRepo();
    await repo.record(succeeded);
    const reversal = await repo.record({
      ...succeeded,
      providerStatusCode: '-3',
      normalizedStatus: 'charged_back',
      payloadSha256: 'b'.repeat(64),
      sanitizedPayload: { ...succeeded.sanitizedPayload, status_code: '-3' },
      receivedAt: new Date('2026-07-29T12:00:00.000Z'),
    });

    expect(reversal.inserted).toBe(true);
    expect(await repo.listForReconciliation(succeeded.paymentId)).toHaveLength(2);
  });

  it('does not add evidence fields to the ordinary payment projection', async () => {
    const payments = new InMemoryPaymentRepo();
    const projection = await payments.create({
      bookingId: 'booking-1',
      provider: 'payhere',
      orderId: 'CH-ABC12',
      amount: 4_000,
      currency: 'USD',
      idempotencyKey: 'checkout-1',
    });

    expect(projection).not.toHaveProperty('sanitizedPayload');
    expect(projection).not.toHaveProperty('payloadSha256');
  });
});
