import { describe, it, expect } from 'vitest';
import { InMemoryBookingCheckoutEventRepo, toCheckoutEvent } from './bookingCheckoutEventRepo';

const B1 = '11111111-1111-4111-8111-111111111111';
const B2 = '22222222-2222-4222-8222-222222222222';

describe('InMemoryBookingCheckoutEventRepo', () => {
  it('records an attempt and lists a booking’s attempts newest first', async () => {
    const repo = new InMemoryBookingCheckoutEventRepo();
    const t0 = new Date('2026-09-24T10:00:00Z');
    await repo.record({ action: 'create', outcome: 'succeeded', bookingId: B1, reference: 'CH-8UVYG', channel: 'website', httpStatus: 201, source: 'server' }, t0);
    await repo.record({ action: 'checkout', outcome: 'succeeded', bookingId: B1, orderId: 'CH-8UVYG', attempt: 1, httpStatus: 200, source: 'server' }, new Date(t0.getTime() + 1000));
    await repo.record({ action: 'gateway', outcome: 'error', bookingId: B1, reason: 'PH-0014 hash mismatch', source: 'client', ua: 'Mozilla/5.0' }, new Date(t0.getTime() + 2000));
    await repo.record({ action: 'create', outcome: 'refused', reason: 'date_in_past', httpStatus: 400, source: 'server' }, new Date(t0.getTime() + 3000));
    await repo.record({ action: 'checkout', outcome: 'refused', bookingId: B2, reason: 'not_chargeable', httpStatus: 409, source: 'server' }, new Date(t0.getTime() + 4000));

    const rows = await repo.listByBookingId(B1);
    expect(rows.map((r) => r.action)).toEqual(['gateway', 'checkout', 'create']);
    expect(rows[0]).toMatchObject({ outcome: 'error', reason: 'PH-0014 hash mismatch', source: 'client', ua: 'Mozilla/5.0', httpStatus: null, attempt: null });
    expect(rows[2]).toMatchObject({ reference: 'CH-8UVYG', channel: 'website', httpStatus: 201, orderId: null });
    expect(rows[0].id).toBeTruthy();
    expect(rows[0].at.getTime()).toBe(t0.getTime() + 2000);
    expect(await repo.listByBookingId(B2)).toHaveLength(1);
    expect(await repo.listByBookingId('33333333-3333-4333-8333-333333333333')).toEqual([]);
  });

  it('caps reason at 200 and ua at 300 characters', () => {
    const e = toCheckoutEvent(
      { action: 'gateway', outcome: 'error', reason: 'x'.repeat(500), ua: 'y'.repeat(500), source: 'client' },
      new Date(),
    );
    expect(e.reason).toHaveLength(200);
    expect(e.ua).toHaveLength(300);
  });

  it('returns copies, so a caller cannot edit the log', async () => {
    const repo = new InMemoryBookingCheckoutEventRepo();
    await repo.record({ action: 'return', outcome: 'pending', bookingId: B1, source: 'server' });
    const [row] = await repo.listByBookingId(B1);
    row!.outcome = 'settled';
    expect((await repo.listByBookingId(B1))[0]!.outcome).toBe('pending');
  });
});
