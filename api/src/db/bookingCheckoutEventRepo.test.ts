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

// The daily digest's payments line (2026-09-24): a founder early warning when website payments
// start failing, read from this log so nobody has to run SQL.
describe('InMemoryBookingCheckoutEventRepo.summarySince', () => {
  const since = new Date('2026-09-24T00:00:00Z');
  const at = (min: number) => new Date(since.getTime() + min * 60_000);
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'].map((c) => `${c.repeat(8)}-${c.repeat(4)}-4${c.repeat(3)}-8${c.repeat(3)}-${c.repeat(12)}`);
  const [PAID, DECLINED, CANCELLED, SILENT, RETRIED, OLD] = ids as [string, string, string, string, string, string];

  async function seeded() {
    const repo = new InMemoryBookingCheckoutEventRepo();
    const ev = (bookingId: string | null, action: 'create' | 'checkout' | 'webhook', outcome: 'succeeded' | 'refused' | 'error' | 'settled' | 'failed' | 'dismissed' | 'pending', min: number) =>
      repo.record({ action, outcome, bookingId, source: 'server' }, at(min));
    await ev(PAID, 'checkout', 'succeeded', 1);
    await ev(PAID, 'webhook', 'settled', 2);
    await ev(DECLINED, 'checkout', 'succeeded', 3);
    await ev(DECLINED, 'webhook', 'failed', 4);
    await ev(CANCELLED, 'checkout', 'succeeded', 5);
    await ev(CANCELLED, 'webhook', 'dismissed', 6);
    await ev(SILENT, 'checkout', 'succeeded', 7);
    await ev(SILENT, 'webhook', 'pending', 8); // pending never became an answer: no answer
    // Declined, tried again, paid: counted once, as paid.
    await ev(RETRIED, 'checkout', 'succeeded', 9);
    await ev(RETRIED, 'webhook', 'failed', 10);
    await ev(RETRIED, 'checkout', 'succeeded', 11);
    await ev(RETRIED, 'webhook', 'settled', 12);
    // Before the window: not counted, even though it settles inside it.
    await ev(OLD, 'checkout', 'succeeded', -5);
    await ev(OLD, 'webhook', 'settled', 1);
    // A refused checkout is not a started one.
    await ev(ids[5]!.replace(/f/g, '9'), 'checkout', 'refused', 2);
    await ev(null, 'create', 'refused', 3);
    await ev(null, 'create', 'error', 4);
    await ev(null, 'create', 'refused', -10); // before the window
    await ev(PAID, 'create', 'succeeded', 0);
    return repo;
  }

  it('counts started / paid / declined / cancelled / no answer per booking, plus refused creates', async () => {
    const repo = await seeded();
    expect(await repo.summarySince(since)).toEqual({
      started: 5, paid: 2, declined: 1, cancelledAtGateway: 1, abandoned: 1, createRefused: 2,
    });
  });

  it('leaves out the bookings it is told to (team test bookings)', async () => {
    const repo = await seeded();
    expect(await repo.summarySince(since, { excludeBookingIds: [PAID, SILENT] })).toEqual({
      started: 3, paid: 1, declined: 1, cancelledAtGateway: 1, abandoned: 0, createRefused: 2,
    });
  });

  it('is all zeros on an empty log', async () => {
    expect(await new InMemoryBookingCheckoutEventRepo().summarySince(since)).toEqual({
      started: 0, paid: 0, declined: 0, cancelledAtGateway: 0, abandoned: 0, createRefused: 0,
    });
  });
});
