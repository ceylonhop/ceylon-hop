import { describe, it, expect, vi } from 'vitest';
import { FakeAlertAdapter } from '../adapters/alerts';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { futureIsoDate } from '../testSupport/dates';
import { closeLeftoverDuplicates } from './duplicateBookings';

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
function mk(reference: string, status: string, createdAt: string, trip: { mode: string; input: object }): Row {
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

describe('closeLeftoverDuplicates — the customer paid for the same trip on a newer booking', () => {
  it("Lea's shape: the older pending booking is cancelled with the reason, seats released, one info alert", async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared({ email: '  LEA@example.com ' }));
    const { bookings, departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);

    const closed = await closeLeftoverDuplicates(paid, deps);

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
    await closeLeftoverDuplicates(paid, deps);
    expect(bookings.byId.get('id-CH-Y5RXW').status).toBe('cancelled');
  });

  for (const [what, older] of [
    ['a different travel date', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ date: futureIsoDate(8) }))],
    ['a different customer', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ email: 'someone@else.com' }))],
    ['a different departure time', () => mk('CH-Y5RXW', 'payment_pending', at(0), shared({ time: '14:00' }))],
    ['an older booking that is already paid', () => mk('CH-Y5RXW', 'paid', at(0), shared())],
  ] as const) {
    it(`${what}: untouched, no seats released, no alert`, async () => {
      const paid = mk('CH-L72HX', 'paid', at(20), shared());
      const row = older();
      const { bookings, departures, alerts, deps } = setup([row, paid]);
      expect(await closeLeftoverDuplicates(paid, deps)).toEqual([]);
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
    expect(await closeLeftoverDuplicates(paid, deps)).toEqual([]);
    expect(bookings.byId.get('id-CH-Y5RXW').status).toBe('payment_pending');
    expect(departures.releaseSeats).not.toHaveBeenCalled();
    expect(alerts.sent).toHaveLength(0);
  });

  it('is idempotent — a second run closes nothing and sends no second alert', async () => {
    const paid = mk('CH-L72HX', 'paid', at(20), shared());
    const { departures, alerts, deps } = setup([mk('CH-Y5RXW', 'payment_pending', at(0), shared()), paid]);
    await closeLeftoverDuplicates(paid, deps);
    expect(await closeLeftoverDuplicates(paid, deps)).toEqual([]);
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
    expect(await closeLeftoverDuplicates(paid, deps)).toEqual([]);
    expect(departures.releaseSeats).not.toHaveBeenCalled();
    expect(alerts.sent).toHaveLength(0);
  });
});

// CH-Y8LYF (created 23:38, paid 04:42 next morning) and CH-ULS3L (the same customer, created 23:48,
// last checkout 23:51, never paid). The leftover was NEWER than the paid booking, so it stayed in
// the queue and the hand-cancel that cleared it emailed the customer a cancellation.
const single = (over: Partial<{ time: string; from: string }> = {}) => ({
  mode: 'single' as const,
  input: { from: over.from ?? 'Colombo Airport (CMB)', to: 'Galle', date: TRAVEL, time: over.time, customer },
});

describe('closeLeftoverDuplicates — a NEWER unpaid booking for the same trip', () => {
  const paid = () => mk('CH-Y8LYF', 'paid', at(0), single());

  it("CH-ULS3L's shape: last checkout long before the payment → cancelled like an older one", async () => {
    const newer = mk('CH-ULS3L', 'payment_pending', at(10), single());
    const { bookings, payments, alerts, deps } = setup([newer, paid()]);
    const p = await payments.create({ bookingId: newer.id, provider: 'payhere', orderId: 'CH-ULS3L', amount: 4700, currency: 'USD', idempotencyKey: 'k2' });
    await payments.touchAttempt(p.id);
    const lastAttempt = (await payments.findByBookingId(newer.id))[0].lastAttemptAt!.getTime();

    const closed = await closeLeftoverDuplicates(paid(), deps, new Date(lastAttempt + 5 * 60 * MIN));

    expect(closed.map((b) => b.reference)).toEqual(['CH-ULS3L']);
    expect(bookings.byId.get(newer.id).cancellationReason).toBe('duplicate — paid on CH-Y8LYF');
    expect(alerts.sent).toHaveLength(1);
  });

  it('a checkout on it within the last 30 minutes → left alone (the customer may still be paying it)', async () => {
    const newer = mk('CH-ULS3L', 'payment_pending', at(10), single());
    const { bookings, payments, alerts, deps } = setup([newer, paid()]);
    const p = await payments.create({ bookingId: newer.id, provider: 'payhere', orderId: 'CH-ULS3L', amount: 4700, currency: 'USD', idempotencyKey: 'k2' });
    await payments.touchAttempt(p.id);
    const lastAttempt = (await payments.findByBookingId(newer.id))[0].lastAttemptAt!.getTime();

    expect(await closeLeftoverDuplicates(paid(), deps, new Date(lastAttempt + 29 * MIN))).toEqual([]);
    expect(bookings.setStatus).not.toHaveBeenCalled();
    expect(alerts.sent).toHaveLength(0);
  });

  it('no checkout yet: judged by when it was created', async () => {
    const newer = mk('CH-ULS3L', 'draft', at(10), single());
    const { bookings, deps } = setup([newer, paid()]);
    expect(await closeLeftoverDuplicates(paid(), deps, new Date(T0 + 39 * MIN))).toEqual([]);
    expect(bookings.byId.get(newer.id).status).toBe('draft');
    expect((await closeLeftoverDuplicates(paid(), deps, new Date(T0 + 40 * MIN))).map((b) => b.reference)).toEqual(['CH-ULS3L']);
  });

  it('two pick-ups at different times of day are two trips, not a duplicate', async () => {
    const other = mk('CH-ULS3L', 'payment_pending', at(-10), single({ time: '16:00' }));
    const paidAt8 = mk('CH-Y8LYF', 'paid', at(0), single({ time: '08:00' }));
    const { bookings, deps } = setup([other, paidAt8]);
    expect(await closeLeftoverDuplicates(paidAt8, deps, new Date(T0 + 600 * MIN))).toEqual([]);
    expect(bookings.byId.get(other.id).status).toBe('payment_pending');
  });

  it('a time on only one of them still matches (a retry may leave the time to confirm)', async () => {
    const older = mk('CH-ULS3L', 'payment_pending', at(-10), single());
    const paidAt8 = mk('CH-Y8LYF', 'paid', at(0), single({ time: '08:00' }));
    const { deps } = setup([older, paidAt8]);
    expect((await closeLeftoverDuplicates(paidAt8, deps)).map((b) => b.reference)).toEqual(['CH-ULS3L']);
  });
});
