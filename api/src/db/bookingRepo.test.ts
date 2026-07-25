import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from './bookingRepo';

const sample: NewBooking = {
  mode: 'single',
  input: {
    from: 'A',
    to: 'B',
    vehicleType: 'car',
    adults: 1,
    children: 0,
    bags: 0,
    customer: { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 4000,
  amountDueNow: 4000,
  currency: 'USD',
};

describe('InMemoryBookingRepo', () => {
  it('creates bookings with unique ids and CH- references', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    const b = await repo.create(sample);
    expect(a.id).not.toBe(b.id);
    expect(a.reference).toMatch(/^CH-[A-Z2-9]{5}$/);
    expect(a.reference).not.toBe(b.reference);
    expect(a.status).toBe('draft');
  });

  it('gets a booking by id, and null for an unknown id', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    expect(await repo.get(a.id)).toEqual(a);
    expect(await repo.get('nope')).toBeNull();
  });

  it('returns the same booking for a repeated idempotency key', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample, { idempotencyKey: 'k1' });
    const b = await repo.create(sample, { idempotencyKey: 'k1' });
    expect(a.id).toBe(b.id);
  });

  it('applies a legal status transition', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    const updated = await repo.setStatus(a.id, 'payment_pending');
    expect(updated.status).toBe('payment_pending');
    expect((await repo.get(a.id))?.status).toBe('payment_pending');
  });

  it('rejects an illegal transition and leaves the row unchanged', async () => {
    const repo = new InMemoryBookingRepo();
    const a = await repo.create(sample);
    await expect(repo.setStatus(a.id, 'completed')).rejects.toThrow();
    expect((await repo.get(a.id))?.status).toBe('draft');
  });

  it('defaults channel to website', async () => {
    const repo = new InMemoryBookingRepo();
    const b = await repo.create(sample);
    expect(b.channel).toBe('website');
  });

  it('persists an explicit whatsapp channel', async () => {
    const repo = new InMemoryBookingRepo();
    const b = await repo.create({ ...sample, channel: 'whatsapp' });
    expect(b.channel).toBe('whatsapp');
  });

  it('is concurrency-safe on the idempotency key: two simultaneous creates yield one booking', async () => {
    const repo = new InMemoryBookingRepo();
    const [a, b] = await Promise.all([
      repo.create(sample, { idempotencyKey: 'k1' }),
      repo.create(sample, { idempotencyKey: 'k1' }),
    ]);
    expect(a.id).toBe(b.id);
    expect((await repo.list()).length).toBe(1);
  });
});
