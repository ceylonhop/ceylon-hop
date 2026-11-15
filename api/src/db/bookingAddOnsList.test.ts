// The one add-ons list (spec 2026-11-14 §7.6). `booking.addOns` is what every email, the manage page
// and the ops pane print, so an add-on bought AFTER booking joins it once it is paid, and leaves it
// once its payment has gone back in full. Exported so postgres.test.ts runs the SAME cases against
// Postgres: the two repos must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { InMemoryBookingRepo, websitePricingSnapshot, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type PaymentRepo } from './paymentRepo';
import { InMemoryRefundRepo, type RefundRepo } from './refundRepo';
import { InMemoryAddOnRepo, type AddOnRepo, type AddOnRequest } from './addOnRepo';
import { quote } from '../quote/engine';
import { RATE_CARD } from '../quote/rateCard';
import type { QuoteRequest } from '../quote/types';

export interface BookingAddOnsListHarness {
  bookings: BookingRepo;
  addOns: AddOnRepo;
  payments: PaymentRepo;
  refunds: RefundRepo;
  /** What settlement does when the request's payment lands. */
  markPaid(requestId: string, at: Date): Promise<void>;
}

const customer = () => ({
  firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 8)}@example.com`,
  whatsapp: '+34600000000', country: 'Spain',
});

// Kandy → Ella → Yala → Galle with the customer taking Ella → Yala themselves: two driven legs.
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
    from: 'Colombo Airport', to: 'Ella', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    date: '2026-12-10', time: '09:00', customer: customer(),
  },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});

const NOW = new Date('2026-12-01T08:00:00Z');
const WAITING_FIRST = 'Waiting fee — Kandy → Ella';
const SIGHTSEEING_FIRST = 'Sightseeing stops (up to 3h) — Kandy → Ella';
const WAITING_LAST = 'Waiting fee — Yala → Galle';

export function bookingAddOnsListContract(name: string, make: () => Promise<BookingAddOnsListHarness>): void {
  describe(name, () => {
    // A paid booking (its trip payment captured) and the legs we drive.
    const seed = async (h: BookingAddOnsListHarness, booking: NewBooking = trip(), opts?: Parameters<BookingRepo['create']>[1]) => {
      const b = await h.bookings.create(booking, opts);
      await h.bookings.setStatus(b.id, 'payment_pending');
      await h.bookings.setStatus(b.id, 'paid');
      const tripPayment = await h.payments.create({
        bookingId: b.id, provider: 'fake', orderId: b.reference, amount: b.total, currency: 'USD',
        idempotencyKey: `checkout:${b.id}`,
      });
      await h.payments.markSucceeded(tripPayment.id);
      const driven = (await h.addOns.listLegs(b.id)).filter((l) => l.kind === 'leg');
      return { b, first: driven[0], last: driven[driven.length - 1] };
    };

    const send = (h: BookingAddOnsListHarness, bookingId: string, lines: Array<{ legId: string; code: string; label: string }>): Promise<AddOnRequest> =>
      h.addOns.createRequest({
        bookingId, lines: lines.map((line) => ({ ...line, amountCents: 1000 })), currency: 'USD', rateCardVersion: 'card-v1',
        createdBy: 'ops@ceylonhop.com', now: NOW, fullyRefundedPaymentIds: [],
      });

    // The request's own payment captured and the request marked paid, as settlement leaves them.
    const pay = async (h: BookingAddOnsListHarness, request: AddOnRequest) => {
      const payment = await h.payments.create({
        bookingId: request.bookingId, provider: 'fake', orderId: `CH-${randomUUID().slice(0, 8)}-A${request.seq}`,
        amount: request.totalCents, currency: 'USD', idempotencyKey: `checkout:${request.bookingId}:addon:${request.id}`,
        purpose: 'add_on',
      });
      await h.addOns.attachPayment(request.id, payment.id);
      await h.payments.markSucceeded(payment.id);
      await h.markPaid(request.id, new Date('2026-12-01T09:00:00Z'));
      return payment;
    };

    const refund = async (h: BookingAddOnsListHarness, bookingId: string, paymentId: string, amountCents: number, confirm = true) => {
      const r = await h.refunds.request({
        bookingId, amountCents, currency: 'USD', reason: 'Customer no longer wants it', requestedBy: 'ops@ceylonhop.com', paymentId,
      });
      if (confirm) await h.refunds.confirm({ bookingId, refundId: r.id, gatewayRef: `rf-${randomUUID()}`, confirmedBy: 'founder@ceylonhop.com' });
    };

    const listed = async (h: BookingAddOnsListHarness, bookingId: string) =>
      (await h.bookings.list({ status: ['paid'] })).find((b) => b.id === bookingId);

    it('lists a paid add-on after the ones chosen at booking', async () => {
      const h = await make();
      const engine: QuoteRequest = {
        product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [{ from: 'Colombo Airport', to: 'Ella', distanceKm: 200 }],
        extras: ['sightseeing'],
      };
      const { b, first } = await seed(h, single(), { pricingSnapshot: websitePricingSnapshot({ engine, result: quote(engine, RATE_CARD) }) });
      expect((await h.bookings.get(b.id))?.addOns).toEqual(['Sightseeing stops (up to 3h)']);

      await pay(h, await send(h, b.id, [{ legId: first.id, code: 'waiting', label: 'Waiting fee — Colombo Airport → Ella' }]));

      const expected = ['Sightseeing stops (up to 3h)', 'Waiting fee — Colombo Airport → Ella'];
      expect((await h.bookings.get(b.id))?.addOns).toEqual(expected);
      expect((await h.bookings.findByReference(b.reference))?.addOns).toEqual(expected);
      expect((await listed(h, b.id))?.addOns).toEqual(expected);
    });

    it('lists paid add-ons in request order, then leg order, then by code', async () => {
      const h = await make();
      const { b, first, last } = await seed(h);
      const one = await send(h, b.id, [{ legId: last.id, code: 'waiting', label: WAITING_LAST }]);
      const two = await send(h, b.id, [
        { legId: first.id, code: 'waiting', label: WAITING_FIRST },
        { legId: first.id, code: 'sightseeing', label: SIGHTSEEING_FIRST },
      ]);
      // Paid out of order: the list follows the requests' numbers, not when the money landed.
      await pay(h, two);
      await pay(h, one);
      const expected = [WAITING_LAST, SIGHTSEEING_FIRST, WAITING_FIRST];
      expect((await h.bookings.get(b.id))?.addOns).toEqual(expected);
      expect((await listed(h, b.id))?.addOns).toEqual(expected);
    });

    it('leaves out a request that is still open, and one that was cancelled', async () => {
      const h = await make();
      const { b, first, last } = await seed(h);
      await send(h, b.id, [{ legId: first.id, code: 'waiting', label: WAITING_FIRST }]);
      const gone = await send(h, b.id, [{ legId: last.id, code: 'waiting', label: WAITING_LAST }]);
      await h.addOns.cancel(gone.id, { by: 'ops@ceylonhop.com', reason: 'Customer changed their mind', now: NOW, inFlightAfter: NOW });

      // No add-ons at all: the field is absent, exactly as on a booking that never had a request.
      const got = await h.bookings.get(b.id);
      expect(got && 'addOns' in got).toBe(false);
      const row = await listed(h, b.id);
      expect(row && 'addOns' in row).toBe(false);
    });

    it('lists only the paid request when another on the same booking is open', async () => {
      const h = await make();
      const { b, first, last } = await seed(h);
      await send(h, b.id, [{ legId: first.id, code: 'waiting', label: WAITING_FIRST }]);
      await pay(h, await send(h, b.id, [{ legId: last.id, code: 'waiting', label: WAITING_LAST }]));
      expect((await h.bookings.get(b.id))?.addOns).toEqual([WAITING_LAST]);
    });

    it('drops a paid add-on once its payment is refunded in full', async () => {
      const h = await make();
      const { b, first } = await seed(h);
      const payment = await pay(h, await send(h, b.id, [{ legId: first.id, code: 'waiting', label: WAITING_FIRST }]));

      // A refund that was only requested has not moved any money yet.
      await refund(h, b.id, payment.id, 1000, false);
      expect((await h.bookings.get(b.id))?.addOns).toEqual([WAITING_FIRST]);

      const [pending] = await h.refunds.list(b.id);
      await h.refunds.confirm({ bookingId: b.id, refundId: pending.id, gatewayRef: `rf-${randomUUID()}`, confirmedBy: 'founder@ceylonhop.com' });
      const got = await h.bookings.get(b.id);
      expect(got && 'addOns' in got).toBe(false);
      const row = await listed(h, b.id);
      expect(row && 'addOns' in row).toBe(false);
    });

    it('keeps a part-refunded add-on, until the refunds add up to the whole payment', async () => {
      const h = await make();
      const { b, first, last } = await seed(h);
      const payment = await pay(h, await send(h, b.id, [{ legId: first.id, code: 'waiting', label: WAITING_FIRST }]));
      // A second paid request on the same booking: its payment is untouched by the refunds below.
      await pay(h, await send(h, b.id, [{ legId: last.id, code: 'waiting', label: WAITING_LAST }]));

      await refund(h, b.id, payment.id, 400);
      expect((await h.bookings.get(b.id))?.addOns).toEqual([WAITING_FIRST, WAITING_LAST]);
      expect((await listed(h, b.id))?.addOns).toEqual([WAITING_FIRST, WAITING_LAST]);

      await refund(h, b.id, payment.id, 600);
      expect((await h.bookings.get(b.id))?.addOns).toEqual([WAITING_LAST]);
      expect((await listed(h, b.id))?.addOns).toEqual([WAITING_LAST]);
    });

    it('a refund of the trip payment does not drop a paid add-on', async () => {
      const h = await make();
      const { b, first } = await seed(h);
      await pay(h, await send(h, b.id, [{ legId: first.id, code: 'waiting', label: WAITING_FIRST }]));
      const tripPayment = (await h.payments.findByBookingId(b.id)).find((p) => p.purpose !== 'add_on')!;
      await refund(h, b.id, tripPayment.id, 5000);
      expect((await h.bookings.get(b.id))?.addOns).toEqual([WAITING_FIRST]);
    });
  });
}

bookingAddOnsListContract('InMemoryBookingRepo', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const refunds = new InMemoryRefundRepo(bookings, payments);
  const addOns = new InMemoryAddOnRepo(bookings, payments);
  bookings.attachAddOns({ addOns, payments, refunds });
  return { bookings, addOns, payments, refunds, markPaid: async (requestId, at) => addOns.markPaidForSettlement(requestId, at) };
});
