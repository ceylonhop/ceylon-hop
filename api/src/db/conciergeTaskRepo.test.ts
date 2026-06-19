import { describe, it, expect } from 'vitest';
import { InMemoryConciergeTaskRepo } from './conciergeTaskRepo';

describe('InMemoryConciergeTaskRepo', () => {
  it('creates an open task and lists it by booking', async () => {
    const repo = new InMemoryConciergeTaskRepo();
    const t = await repo.create({ bookingId: 'b1', type: 'confirm_pickup' });
    expect(t.status).toBe('open');
    expect(t.type).toBe('confirm_pickup');
    expect(await repo.listByBooking('b1')).toHaveLength(1);
    expect(await repo.listByBooking('other')).toHaveLength(0);
  });
});
