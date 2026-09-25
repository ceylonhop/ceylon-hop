import { describe, it, expect, vi } from 'vitest';
import { FakeAlertAdapter } from '../adapters/alerts';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { futureIsoDate } from '../testSupport/dates';
import { closeOlderDuplicates } from './duplicateBookings';

// CH-Y5RXW (declined at 3-D Secure, left payment_pending) and CH-L72HX (the same shared seat,
// paid 20 min later). When the second one settles, the first is a leftover: close it quietly.
const MIN = 60_000;
const T0 = Date.now();
const TRAVEL = futureIsoDate(7);
const at = (min: number) => new Date(T0 + min * MIN).toISOString();
const customer = { firstName: 'Lea', lastName: 'M', email: 'lea@example.com', whatsapp: '+491700000000', country: 'Germany' };
const shared = (over: Partial<{ date: string; time: string; corridorId: string; email: string }> = {}) => ({
  mode: 'shared' as const,
  input: {
    corridorId: over.corridorId ?? 'ella-east', fromPlace: 'Ella', toPlace: 'Arugam Bay', date: over.date ?? TRAVEL,
    time: over.time ?? '09:00', seats: 2, bags: 1, customer: { ...customer, email: over.email ?? customer.email },
  },
});
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = any;
function mk(reference: string, status: string, createdAt: string, trip: ReturnType<typeof shared>): Row {
  return { id: `id-${reference}`, reference, status, createdAt, channel: 'website', currency: 'USD', total: 4600, amountDueNow: 4600, ...trip };
}
function repo(rows: Row[]) {
  const byId = new Map(rows.map((r) => [r.id, { ...r }]));
  return {
    byId,
    list: async ({ status }: { status?: string | string[] } = {}) => {
      const want = Array.isArray(status) ? status : status ? [status] : null;
      return [...byId.values()].filter((b) => !want || want.includes(b.status));
    },
    setStatus: vi.fn(async (id: string, to: string, audit?: { reason: string; by: string }) => {
      const cur = byId.get(id)!;
      if (!['draft', 'payment_pending'].includes(cur.status)) {
        const { IllegalTransitionError } = await import('../domain/status');
        throw new IllegalTransitionError(cur.status, to as never);
      }
      const next = { ...cur, status: to, cancellationReason: audit?.reason, cancelledBy: audit?.by };
      byId.set(id, next);
      return next;
    }),
  };
}
function setup(rows: Row[]) {
  const bookings = repo(rows);
  const departures = { releaseSeats: vi.fn(async () => {}) };
  const payments = new InMemoryPaymentRepo();
  const alerts = new FakeAlertAdapter();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const deps = { bookings, departures, payments, alerts } as any;
  return { bookings, departures, payments, alerts, deps };
}

describe('closeOlderDuplicates — the customer paid for the same trip on a newer booking', () => {
  it("Lea's shape: the older pending booking is cancelled with the reason, seats released, one info alert", async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared({ email: '  LEA@example.com ' }));
    const { bookings, departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);

    const closed = await closeOlderDuplicates(paid, deps);

    expect(closed.map((b) => b.reference)).toEqual(['CH-Y5RXW']);
    const old = bookings.byId.get('id-CH-Y5RXW');
    expect(old.status).toBe('cancelled');
    expect(old.cancellationReason).toBe('duplicate — paid on CH-L72HX');
    expect(old.cancelledBy).toBe('system:duplicate-close');
    expect(departures.releaseSeats).toHaveBeenCalledTimes(1);
    expect(departures.releaseSeats).toHaveBeenCalledWith({ corridorId: 'ella-east', date: TRAVEL, time: '09:00', seats: 2 });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatchObject({ severity: 'info', kind: 'duplicate_closed' });
    expect(alerts.sent[0].title).toContain('CH-Y5RXW');
    expect(alerts.sent[0].title).toContain('CH-L72HX');
    expect(bookings.byId.get('id-CH-L72HX').status).toBe('paid');
  });

  it('closes an older DRAFT too', async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared());
    const { bookings, deps } = setup([mk('CH-Y5RXW', 'draft', at(0), shared()), paid]);
    await closeOlderDuplicates(paid, deps);
    expect(bookings.byId.get('id-CH-Y5RXW').status).toBe('cancelled');
  });

  for (const [what, older] of [
    ['a different travel date', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ date: futureIsoDate(8) }))],
    ['a different customer', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ email: 'someone@else.com' }))],
    ['a different departure time', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ time: '14:00' }))],
    ['an older booking that is already paid', () => mk('CH-Y5RXW', 'paid', at(0), shared())],
    ['a NEWER (not older) pending booking', () => mk('CH-Y5RXW', 'payment_pending', at(40), shared())],
  ] as const) {
    it(`${what}: untouched, no seats released, no alert`, async () => {
      const paid = mk('CH-L72HX', 'paid', at(20), shared());
      const row = older();
      const { bookings, departures, alerts, deps } = setup([row, paid]);
      expect(await closeOlderDuplicates(paid, deps)).toEqual([]);
      expect(bookings.byId.get(row.id).status).toBe(row.status);
      expect(bookings.setStatus).not.toHaveBeenCalled();
      expect(departures.releaseSeats).not.toHaveBeenCalled();
      expect(alerts.sent).toHaveLength(0);
    });
  }

  it('never touches an older booking that has a succeeded payment, whatever its status says', async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared());
    const { bookings, payments, departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);
    const p = await payments.create({ bookingId: 'id-CH-Y5RXW', provider: 'payhere', orderId: 'CH-Y5RXW', amount: 4600, currency: 'USD', idempotencyKey: 'k1' });
    await payments.markSucceeded(p.id);
    expect(await closeOlderDuplicates(paid, deps)).toEqual([]);
    expect(bookings.byId.get('id-CH-Y5RXW').status).toBe('payment_pending');
    expect(departures.releaseSeats).not.toHaveBeenCalled();
    expect(alerts.sent).toHaveLength(0);
  });

  it('is idempotent — a second run closes nothing and sends no second alert', async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared());
    const { departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);
    await closeOlderDuplicates(paid, deps);
    expect(await closeOlderDuplicates(paid, deps)).toEqual([]);
    expect(departures.releaseSeats).toHaveBeenCalledTimes(1);
    expect(alerts.sent).toHaveLength(1);
  });

  it('a booking that moved on between the list and the cancel (lost race) is skipped, seats not released', async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared());
    const { bookings, departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);
    const list = bookings.list;
    bookings.list = async (f) => {
      const rows = await list(f);
      bookings.byId.set('id-CH-Y5RXW', { ...bookings.byId.get('id-CH-Y5RXW'), status: 'paid' }); // its own notify landed
      return rows;
    };
    expect(await closeOlderDuplicates(paid, deps)).toEqual([]);
    expect(departures.releaseSeats).not.toHaveBeenCalled();
    expect(alerts.sent).toHaveLength(0);
  });
});
