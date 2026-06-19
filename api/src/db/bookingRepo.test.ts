import { describe, it, expect } from 'vitest';
import { InMemoryBookingRepo, type NewBooking } from './bookingRepo';

const sample: NewBooking = {
  input: { from: 'A', to: 'B', vehicleType: 'car', adults: 1, children: 0, bags: 0 },
  total: 4000,
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
});
