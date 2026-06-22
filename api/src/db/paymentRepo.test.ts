import { describe, it, expect } from 'vitest';
import { InMemoryPaymentRepo, type NewPayment } from './paymentRepo';

const np: NewPayment = {
  bookingId: 'b1',
  provider: 'fake',
  orderId: 'CH-1',
  amount: 5000,
  currency: 'USD',
  idempotencyKey: 'k1',
};

describe('InMemoryPaymentRepo', () => {
  it('creates a pending payment', async () => {
    const r = new InMemoryPaymentRepo();
    const p = await r.create(np);
    expect(p.status).toBe('pending');
    expect(p.id).toBeTruthy();
  });

  it('is idempotent on the idempotency key', async () => {
    const r = new InMemoryPaymentRepo();
    const a = await r.create(np);
    const b = await r.create(np);
    expect(a.id).toBe(b.id);
  });

  it('finds by orderId and marks succeeded', async () => {
    const r = new InMemoryPaymentRepo();
    const p = await r.create(np);
    expect((await r.findByOrderId('CH-1'))?.id).toBe(p.id);
    const s = await r.markSucceeded(p.id);
    expect(s.status).toBe('succeeded');
  });

  it('finds all payments for a booking', async () => {
    const r = new InMemoryPaymentRepo();
    await r.create(np);
    await r.create({ ...np, orderId: 'CH-2', idempotencyKey: 'k2' });
    await r.create({ ...np, bookingId: 'b2', orderId: 'CH-3', idempotencyKey: 'k3' });
    expect(await r.findByBookingId('b1')).toHaveLength(2);
    expect(await r.findByBookingId('b2')).toHaveLength(1);
    expect(await r.findByBookingId('nope')).toHaveLength(0);
  });
});
