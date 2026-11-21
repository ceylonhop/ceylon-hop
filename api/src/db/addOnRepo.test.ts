// Add-ons after booking (spec 2026-11-14 §4.3, §4.5, §5). One request = one or more lines on legs of
// one booking, numbered per booking, one of each add-on per leg. Exported so postgres.test.ts runs
// the SAME cases against Postgres: the two repos must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './paymentRepo';
import { AddOnError, InMemoryAddOnRepo, type AddOnRepo, type AddOnRequest } from './addOnRepo';

export interface AddOnRepoHarness {
  repo: AddOnRepo;
  bookings: BookingRepo;
  payments: PaymentRepo;
  /** What settlement will do once it exists: the request's payment landed. */
  markPaid(requestId: string, at: Date): Promise<void>;
}

const customer = () => ({
  firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 8)}@example.com`,
  whatsapp: '+34600000000', country: 'Spain',
});

// Kandy → Ella → Yala → Galle with the customer taking the Ella → Yala stretch themselves: two legs
// we drive and one gap between them.
const trip = (): NewBooking => ({
  mode: 'trip',
  input: {
    stops: ['Kandy', 'Ella', 'Yala', 'Galle'], nights: [1, 1, 1, 0], dates: ['2026-12-10', '', '2026-12-14'],
    gaps: [1], pax: 2, vehicleType: 'car', serviceType: 'private', customer: customer(),
  },
  total: 24000, amountDueNow: 24000, currency: 'USD',
});

const single = (): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    date: '2026-12-10', time: '09:00', customer: customer(),
  },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});

const NOW = new Date('2026-12-01T08:00:00Z');
const waiting = (legId: string) => ({ legId, code: 'waiting', label: 'Waiting fee — Kandy → Ella', amountCents: 1000 });
const sightseeing = (legId: string) => ({ legId, code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1500 });

const errorCode = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (e) {
    if (e instanceof AddOnError) return e.code;
    throw e;
  }
  return 'no_error';
};

export function addOnRepoContract(name: string, make: () => Promise<AddOnRepoHarness>): void {
  describe(name, () => {
    const create = (
      repo: AddOnRepo, bookingId: string, lines: Array<ReturnType<typeof waiting>>, fullyRefundedPaymentIds: string[] = [],
    ): Promise<AddOnRequest> =>
      repo.createRequest({
        bookingId, lines, currency: 'USD', rateCardVersion: 'card-v1', createdBy: 'ops@ceylonhop.com', now: NOW,
        fullyRefundedPaymentIds,
      });

    // A booking, its first driven leg, and (for the trip) its last.
    const seed = async (h: AddOnRepoHarness, booking: NewBooking = trip()) => {
      const b = await h.bookings.create(booking);
      const legs = await h.repo.listLegs(b.id);
      const driven = legs.filter((l) => l.kind === 'leg');
      return { b, legs, first: driven[0], last: driven[driven.length - 1] };
    };

    const pendingPayment = async (h: AddOnRepoHarness, bookingId: string, request: AddOnRequest) => {
      const payment = await h.payments.create({
        bookingId, provider: 'fake', orderId: `CH-${randomUUID().slice(0, 8)}-A${request.seq}`,
        amount: request.totalCents, currency: 'USD', idempotencyKey: `checkout:${bookingId}:addon:${request.id}`,
        purpose: 'add_on',
      });
      await h.repo.attachPayment(request.id, payment.id);
      return payment;
    };

    describe('listLegs', () => {
      // Per-leg ops steps (spec 2026-11-19): the ops queue reads many trips' legs in one go.
      it('listLegsForBookings returns each booking’s legs exactly as listLegs does', async () => {
        const h = await make();
        const a = await h.bookings.create(trip());
        const b = await h.bookings.create(single());
        const many = await h.repo.listLegsForBookings([a.id, b.id, randomUUID()]);
        expect([...many.keys()].sort()).toEqual([a.id, b.id].sort());
        expect(many.get(a.id)).toEqual(await h.repo.listLegs(a.id));
        expect(many.get(b.id)).toEqual(await h.repo.listLegs(b.id));
        expect(await h.repo.listLegsForBookings([])).toEqual(new Map());
      });

      it('returns a trip’s stored legs in seq order, gaps included', async () => {
        const h = await make();
        const { legs } = await seed(h);
        expect(legs.map((l) => [l.seq, l.kind, l.from, l.to, l.travelDate])).toEqual([
          [1, 'leg', 'Kandy', 'Ella', '2026-12-10'],
          [2, 'gap', 'Ella', 'Yala', null],
          [3, 'leg', 'Yala', 'Galle', '2026-12-14'],
        ]);
        expect(legs.every((l) => Array.isArray(l.viaStops))).toBe(true);
        expect(new Set(legs.map((l) => l.id)).size).toBe(3);
      });

      it('returns a single transfer’s one leg', async () => {
        const h = await make();
        const { legs } = await seed(h, single());
        expect(legs).toHaveLength(1);
        expect(legs[0]).toMatchObject({ seq: 1, kind: 'leg', from: 'Colombo Airport (CMB)', to: 'Galle', viaStops: [], travelDate: '2026-12-10' });
      });

      it('gives each leg the same id on every read', async () => {
        const h = await make();
        const { b, legs } = await seed(h);
        expect((await h.repo.listLegs(b.id)).map((l) => l.id)).toEqual(legs.map((l) => l.id));
      });

      it('follows a pickup date change', async () => {
        const h = await make();
        const { b, legs } = await seed(h, single());
        await h.bookings.setStatus(b.id, 'payment_pending');
        const moved = await h.bookings.setSchedule(b.id, {
          date: '2026-12-12', time: '09:00', expected: { date: '2026-12-10', time: '09:00' },
          actor: { type: 'staff', id: 'ops@ceylonhop.com' },
        });
        expect(moved.ok).toBe(true);
        const after = await h.repo.listLegs(b.id);
        expect(after[0].travelDate).toBe('2026-12-12');
        expect(after[0].id).toBe(legs[0].id);
      });

      it('returns nothing for a booking it does not know', async () => {
        const h = await make();
        expect(await h.repo.listLegs(randomUUID())).toEqual([]);
      });
    });

    describe('createRequest', () => {
      it('numbers requests 1, 2 per booking, independently of other bookings', async () => {
        const h = await make();
        const one = await seed(h);
        const other = await seed(h);
        expect((await create(h.repo, one.b.id, [waiting(one.first.id)])).seq).toBe(1);
        expect((await create(h.repo, one.b.id, [waiting(one.last.id)])).seq).toBe(2);
        expect((await create(h.repo, other.b.id, [waiting(other.first.id)])).seq).toBe(1);
      });

      it('stores an open request whose total is the sum of its lines', async () => {
        const h = await make();
        const { b, first, last } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(last.id), waiting(first.id), sightseeing(first.id)]);
        expect(req).toMatchObject({
          bookingId: b.id, seq: 1, status: 'open', totalCents: 3500, currency: 'USD', rateCardVersion: 'card-v1',
          paymentId: null, createdBy: 'ops@ceylonhop.com', paidAt: null,
          cancelledBy: null, cancelledAt: null, cancelReason: null,
        });
        expect(req.createdAt.toISOString()).toBe(NOW.toISOString());
        // Lines read back in leg order, then by code: the table keeps no order of its own.
        expect(req.lines.map((l) => ({ ...l, id: typeof l.id }))).toEqual([
          { id: 'string', requestId: req.id, bookingId: b.id, legId: first.id, code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Kandy → Ella', amountCents: 1500 },
          { id: 'string', requestId: req.id, bookingId: b.id, legId: first.id, code: 'waiting', label: 'Waiting fee — Kandy → Ella', amountCents: 1000 },
          { id: 'string', requestId: req.id, bookingId: b.id, legId: last.id, code: 'waiting', label: 'Waiting fee — Kandy → Ella', amountCents: 1000 },
        ]);
        expect(new Set(req.lines.map((l) => l.id)).size).toBe(3);
        expect(await h.repo.get(req.id)).toEqual(req);
      });

      it('refuses a booking that does not exist', async () => {
        const h = await make();
        const { first } = await seed(h);
        expect(await errorCode(create(h.repo, randomUUID(), [waiting(first.id)]))).toBe('booking_not_found');
      });

      it('refuses the same add-on on the same leg while the first request is open', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        await create(h.repo, b.id, [waiting(first.id)]);
        expect(await errorCode(create(h.repo, b.id, [sightseeing(first.id), waiting(first.id)]))).toBe('duplicate_add_on');
        // Refused whole: the sightseeing line beside the duplicate was not stored either.
        expect(await h.repo.listByBooking(b.id)).toHaveLength(1);
      });

      it('refuses the same add-on twice in one request', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        expect(await errorCode(create(h.repo, b.id, [waiting(first.id), waiting(first.id)]))).toBe('duplicate_add_on');
        expect(await h.repo.listByBooking(b.id)).toEqual([]);
      });

      it('refuses it while the first request is paid, and allows it once that payment is fully refunded', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const paid = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, paid);
        await h.markPaid(paid.id, new Date('2026-12-01T09:00:00Z'));
        expect(await errorCode(create(h.repo, b.id, [waiting(first.id)]))).toBe('duplicate_add_on');
        expect(await errorCode(create(h.repo, b.id, [waiting(first.id)], [randomUUID()]))).toBe('duplicate_add_on');
        const again = await create(h.repo, b.id, [waiting(first.id)], [payment.id]);
        expect(again.seq).toBe(2);
      });

      it('allows it again after the first request is cancelled', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const gone = await create(h.repo, b.id, [waiting(first.id)]);
        await h.repo.cancel(gone.id, { by: 'ops@ceylonhop.com', reason: 'Customer changed their mind', now: NOW, inFlightAfter: NOW });
        expect((await create(h.repo, b.id, [waiting(first.id)])).seq).toBe(2);
      });

      it('allows the same add-on on a different leg, and a different add-on on the same leg', async () => {
        const h = await make();
        const { b, first, last } = await seed(h);
        expect(first.id).not.toBe(last.id);
        await create(h.repo, b.id, [waiting(first.id)]);
        expect((await create(h.repo, b.id, [waiting(last.id)])).seq).toBe(2);
        expect((await create(h.repo, b.id, [sightseeing(first.id)])).seq).toBe(3);
      });

      it('two staff sending the same line at once make exactly one request', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const results = await Promise.allSettled([
          create(h.repo, b.id, [waiting(first.id)]),
          create(h.repo, b.id, [waiting(first.id)]),
        ]);
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
        const refused = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        expect(refused.reason).toBeInstanceOf(AddOnError);
        expect((refused.reason as AddOnError).code).toBe('duplicate_add_on');
        expect(await h.repo.listByBooking(b.id)).toHaveLength(1);
      });

      it('two staff sending different lines at once get seq 1 and 2', async () => {
        const h = await make();
        const { b, first, last } = await seed(h);
        const made = await Promise.all([
          create(h.repo, b.id, [waiting(first.id)]),
          create(h.repo, b.id, [waiting(last.id)]),
        ]);
        expect(made.map((r) => r.seq).sort()).toEqual([1, 2]);
      });
    });

    describe('reads', () => {
      it('get returns null for a request it does not know', async () => {
        const h = await make();
        expect(await h.repo.get(randomUUID())).toBeNull();
      });

      it('listByBooking returns a booking’s requests in seq order with their lines', async () => {
        const h = await make();
        const { b, first, last } = await seed(h);
        const one = await create(h.repo, b.id, [waiting(first.id)]);
        const two = await create(h.repo, b.id, [waiting(last.id), sightseeing(last.id)]);
        expect(await h.repo.listByBooking(b.id)).toEqual([one, two]);
        expect(await h.repo.listByBooking(randomUUID())).toEqual([]);
      });

      it('listByBookingIds groups by booking and gives a booking with none an empty list', async () => {
        const h = await make();
        const one = await seed(h);
        const other = await seed(h);
        const none = await seed(h, single());
        const a1 = await create(h.repo, one.b.id, [waiting(one.first.id)]);
        const a2 = await create(h.repo, one.b.id, [sightseeing(one.first.id)]);
        const b1 = await create(h.repo, other.b.id, [waiting(other.first.id)]);
        const byBooking = await h.repo.listByBookingIds([one.b.id, other.b.id, none.b.id]);
        expect([...byBooking.keys()].sort()).toEqual([one.b.id, other.b.id, none.b.id].sort());
        expect(byBooking.get(one.b.id)).toEqual([a1, a2]);
        expect(byBooking.get(other.b.id)).toEqual([b1]);
        expect(byBooking.get(none.b.id)).toEqual([]);
        expect((await h.repo.listByBookingIds([])).size).toBe(0);
      });
    });

    describe('cancel', () => {
      const at = new Date('2026-12-02T10:00:00Z');
      const by = { by: 'ops@ceylonhop.com', reason: 'Customer changed their mind', now: at };

      it('cancels an open request and records who, when and why', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const cancelled = await h.repo.cancel(req.id, { ...by, inFlightAfter: at });
        expect(cancelled).toMatchObject({
          id: req.id, status: 'cancelled', cancelledBy: 'ops@ceylonhop.com', cancelReason: 'Customer changed their mind', paidAt: null,
        });
        expect(cancelled.cancelledAt?.toISOString()).toBe(at.toISOString());
        expect(cancelled.lines).toEqual(req.lines);
        expect(await h.repo.get(req.id)).toEqual(cancelled);
      });

      it('refuses a request it does not know', async () => {
        const h = await make();
        expect(await errorCode(h.repo.cancel(randomUUID(), { ...by, inFlightAfter: at }))).toBe('request_not_found');
      });

      it('refuses a paid request: that is a refund', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        await pendingPayment(h, b.id, req);
        const paidAt = new Date('2026-12-01T09:00:00Z');
        await h.markPaid(req.id, paidAt);
        expect(await errorCode(h.repo.cancel(req.id, { ...by, inFlightAfter: at }))).toBe('already_paid');
        const stored = await h.repo.get(req.id);
        expect(stored).toMatchObject({ status: 'paid', cancelledBy: null });
        expect(stored?.paidAt?.toISOString()).toBe(paidAt.toISOString());
      });

      it('refuses a request that is already cancelled, and keeps the first cancellation', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        await h.repo.cancel(req.id, { ...by, inFlightAfter: at });
        expect(await errorCode(h.repo.cancel(req.id, { by: 'other@ceylonhop.com', reason: 'Again', now: new Date(), inFlightAfter: at }))).toBe('not_open');
        expect(await h.repo.get(req.id)).toMatchObject({ cancelledBy: 'ops@ceylonhop.com', cancelReason: 'Customer changed their mind' });
      });

      it('refuses while a PayHere form may still be open on its payment', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, req);
        await h.payments.touchAttempt(payment.id); // a checkout started just now
        const halfAnHourAgo = new Date(Date.now() - 30 * 60 * 1000);
        expect(await errorCode(h.repo.cancel(req.id, { ...by, inFlightAfter: halfAnHourAgo }))).toBe('payment_in_flight');
        expect((await h.repo.get(req.id))?.status).toBe('open');
      });

      it('allows it once that attempt is older than the window', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, req);
        await h.payments.touchAttempt(payment.id);
        const afterTheAttempt = new Date(Date.now() + 60 * 1000);
        expect((await h.repo.cancel(req.id, { ...by, inFlightAfter: afterTheAttempt })).status).toBe('cancelled');
      });

      it('allows it when the payment row exists but no checkout was ever started on it', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        await pendingPayment(h, b.id, req);
        expect((await h.repo.cancel(req.id, { ...by, inFlightAfter: new Date(0) })).status).toBe('cancelled');
      });

      it('allows it after the payment failed, however recent the attempt', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, req);
        await h.payments.touchAttempt(payment.id);
        await h.payments.markFailed(payment.id);
        expect((await h.repo.cancel(req.id, { ...by, inFlightAfter: new Date(0) })).status).toBe('cancelled');
      });
    });

    describe('attachPayment', () => {
      it('sets the payment once; the same id again is a no-op', async () => {
        const h = await make();
        const { b, first } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, req);
        await h.repo.attachPayment(req.id, payment.id);
        expect((await h.repo.get(req.id))?.paymentId).toBe(payment.id);
      });

      it('never swaps in a different payment', async () => {
        const h = await make();
        const { b, first, last } = await seed(h);
        const req = await create(h.repo, b.id, [waiting(first.id)]);
        const payment = await pendingPayment(h, b.id, req);
        const other = await pendingPayment(h, b.id, await create(h.repo, b.id, [waiting(last.id)]));
        await expect(h.repo.attachPayment(req.id, other.id)).rejects.toThrow();
        expect((await h.repo.get(req.id))?.paymentId).toBe(payment.id);
      });

      it('refuses a request it does not know', async () => {
        const h = await make();
        expect(await errorCode(h.repo.attachPayment(randomUUID(), randomUUID()))).toBe('request_not_found');
      });
    });
  });
}

addOnRepoContract('InMemoryAddOnRepo', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const repo = new InMemoryAddOnRepo(bookings, payments);
  return { repo, bookings, payments, markPaid: async (requestId, at) => repo.markPaidForSettlement(requestId, at) };
});
