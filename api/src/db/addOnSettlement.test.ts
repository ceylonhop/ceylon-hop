// Settling an add-on payment (spec 2026-11-14 §6.3). The money for an add-on request lands on its
// own payment row: the request becomes paid and the booking is left exactly as it was. Money that
// arrives for a request nobody wants any more (cancelled, or its booking is off) is kept and
// handed to a human. Exported so postgres.test.ts runs the SAME cases against Postgres: the two
// settlement repos must never disagree.
import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import type { VerifiedPaymentEvent } from '../adapters/payments';
import { InMemoryBookingRepo, type Booking, type BookingRepo, type NewBooking } from './bookingRepo';
import { InMemoryPaymentRepo, type Payment, type PaymentRepo } from './paymentRepo';
import { InMemoryPaymentEventRepo, type PaymentEventRepo } from './paymentEventRepo';
import { AddOnError, InMemoryAddOnRepo, type AddOnRepo } from './addOnRepo';
import {
  InMemoryPaymentSettlementRepo,
  PaymentSettlementError,
  type PaymentSettlementRepo,
  type SettlementFailureHook,
} from './paymentSettlementRepo';
import type { BookingStatus } from '../domain/status';

export interface AddOnSettlementHarness {
  bookings: BookingRepo;
  payments: PaymentRepo;
  events: Pick<PaymentEventRepo, 'listForReconciliation'>;
  addOns: AddOnRepo;
  settlement(failureHook?: SettlementFailureHook): PaymentSettlementRepo;
}

const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const single = (over: Partial<NewBooking> = {}): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    date: inDays(10), time: '09:00',
    customer: { firstName: 'Maya', lastName: 'Silva', email: `maya+${randomUUID().slice(0, 8)}@example.com`, whatsapp: '+34600000000', country: 'Spain' },
  },
  total: 12100, amountDueNow: 12100, currency: 'USD',
  ...over,
} as NewBooking);

// How a booking gets to each status from payment_pending, one legal step at a time.
const PATH: Partial<Record<BookingStatus, BookingStatus[]>> = {
  paid: ['paid'],
  confirmed: ['paid', 'confirmed'],
  in_progress: ['paid', 'confirmed', 'in_progress'],
  completed: ['paid', 'confirmed', 'in_progress', 'completed'],
  cancelled: ['paid', 'cancelled'],
  refunded: ['paid', 'refunded'],
  no_show: ['paid', 'confirmed', 'no_show'],
};

const cancelInput = () => ({ by: 'ops@ceylonhop.com', reason: 'Customer changed their mind', now: new Date(), inFlightAfter: new Date(Date.now() + 60_000) });

export function addOnSettlementContract(name: string, make: () => Promise<AddOnSettlementHarness>): void {
  describe(name, () => {
    // A booking in `status` with one add-on request ($10 + $19) whose checkout was started: a
    // pending `add_on` payment row tied to the request, and PayHere's success notice for it.
    const seed = async (h: AddOnSettlementHarness, status: BookingStatus = 'paid', nb: NewBooking = single()) => {
      const created = await h.bookings.create(nb);
      await h.bookings.setStatus(created.id, 'payment_pending');
      for (const to of PATH[status] ?? []) await h.bookings.setStatus(created.id, to);
      const booking = (await h.bookings.get(created.id))!;
      const { request, payment, event } = await addRequest(h, booking);
      return { booking, request, payment, event };
    };

    const addRequest = async (h: AddOnSettlementHarness, booking: Booking, attach = true) => {
      const [leg] = await h.addOns.listLegs(booking.id);
      const request = await h.addOns.createRequest({
        bookingId: booking.id,
        lines: [
          { legId: leg.id, code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Colombo Airport → Galle', amountCents: 1000 },
          { legId: leg.id, code: 'safari-wait', label: 'Wait for Safari — Colombo Airport → Galle', amountCents: 1900 },
        ],
        currency: 'USD', rateCardVersion: 'card-v1', createdBy: 'ops@ceylonhop.com', now: new Date(), fullyRefundedPaymentIds: [],
      });
      const payment = await h.payments.create({
        bookingId: booking.id, provider: 'payhere', orderId: `${booking.reference}-A${request.seq}`, amount: request.totalCents,
        currency: 'USD', idempotencyKey: `checkout:${booking.id}:addon:${request.id}`, purpose: 'add_on',
      });
      if (attach) await h.addOns.attachPayment(request.id, payment.id);
      return { request, payment, event: successFor(payment) };
    };

    // Unique per run: (provider, gateway_payment_id) is UNIQUE, and the test DB persists.
    const successFor = (payment: Payment): VerifiedPaymentEvent => ({
      provider: 'payhere', merchantId: '1234567', orderId: payment.orderId, providerTxnId: `PAY-${randomUUID()}`,
      amountCents: payment.amount, currency: payment.currency, status: 'succeeded', providerStatusCode: '2',
      receivedAt: new Date('2026-11-16T05:35:00.000Z'), payloadSha256: 'a'.repeat(64),
      sanitizedPayload: { order_id: payment.orderId, status_code: '2' },
    });
    const declineOf = (event: VerifiedPaymentEvent): VerifiedPaymentEvent => ({
      ...event, providerTxnId: '0', status: 'failed', providerStatusCode: '-2', payloadSha256: 'b'.repeat(64),
      sanitizedPayload: { order_id: event.orderId, status_code: '-2' },
    });
    const paymentOf = async (h: AddOnSettlementHarness, orderId: string) => (await h.payments.findByOrderId(orderId))!;

    it.each(['paid', 'confirmed', 'in_progress', 'completed'] as const)(
      'settles an add-on on a %s booking: the request is paid and the booking is left alone',
      async (status) => {
        const h = await make();
        const { booking, request, payment, event } = await seed(h, status);

        const outcome = await h.settlement().acceptVerifiedEvent(event);

        expect(outcome.kind).toBe('add_on_settled');
        expect(outcome.payment).toMatchObject({ id: payment.id, status: 'succeeded', purpose: 'add_on', amount: 2900 });
        if (outcome.kind !== 'add_on_settled') throw new Error('unreachable');
        expect(outcome.request).toMatchObject({ id: request.id, status: 'paid', totalCents: 2900, paymentId: payment.id });
        expect(outcome.request.paidAt?.toISOString()).toBe('2026-11-16T05:35:00.000Z');
        expect(outcome.request.lines.map((l) => [l.code, l.amountCents])).toEqual([['safari-wait', 1900], ['sightseeing', 1000]]);
        expect(outcome.booking).toMatchObject({ id: booking.id, status });

        const stored = await h.addOns.get(request.id);
        expect(stored).toMatchObject({ status: 'paid' });
        expect(stored?.paidAt?.toISOString()).toBe('2026-11-16T05:35:00.000Z');
        expect((await paymentOf(h, payment.orderId)).settledAt?.toISOString()).toBe('2026-11-16T05:35:00.000Z');
        const after = (await h.bookings.get(booking.id))!;
        expect(after.status).toBe(status);
        expect(after.amountDueNow).toBe(12100);
        expect(after.total).toBe(12100);
        expect(await h.events.listForReconciliation(payment.id)).toHaveLength(1);
      },
    );

    it('settles an add-on on a pay-on-the-day booking that has no trip payment at all', async () => {
      const h = await make();
      const created = await h.bookings.create(single());
      await h.bookings.setStatus(created.id, 'payment_pending');
      await h.bookings.setPaymentArrangement(created.id, 'on_the_day');
      const booking = await h.bookings.setStatus(created.id, 'confirmed');
      const { request, event } = await addRequest(h, booking);

      expect((await h.settlement().acceptVerifiedEvent(event)).kind).toBe('add_on_settled');
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
      const after = (await h.bookings.get(booking.id))!;
      expect(after).toMatchObject({ status: 'confirmed', paymentArrangement: 'on_the_day', amountDueNow: 12100 });
    });

    it('a re-delivered notice is a duplicate and changes nothing', async () => {
      const h = await make();
      const { request, payment, event } = await seed(h);
      const repo = h.settlement();
      expect((await repo.acceptVerifiedEvent(event)).kind).toBe('add_on_settled');
      expect((await repo.acceptVerifiedEvent(event)).kind).toBe('duplicate');
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
      expect(await h.events.listForReconciliation(payment.id)).toHaveLength(1);
    });

    it('a second capture on the same order is a double capture and keeps the first capture', async () => {
      const h = await make();
      const { request, payment, event } = await seed(h);
      const repo = h.settlement();
      await repo.acceptVerifiedEvent(event);
      const second = await repo.acceptVerifiedEvent({ ...event, providerTxnId: `PAY-${randomUUID()}`, payloadSha256: 'c'.repeat(64) });
      expect(second.kind).toBe('double_capture');
      expect(second).toMatchObject({ firstCaptureTxnId: event.providerTxnId });
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
      expect(await h.payments.gatewayPaymentIdFor(payment.id)).toBe(event.providerTxnId);
    });

    it('a chargeback after it settled is still a reversal', async () => {
      const h = await make();
      const { request, event } = await seed(h);
      const repo = h.settlement();
      await repo.acceptVerifiedEvent(event);
      const back = await repo.acceptVerifiedEvent({ ...event, status: 'charged_back', providerStatusCode: '-3', payloadSha256: 'd'.repeat(64) });
      expect(back.kind).toBe('reversal');
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
    });

    it('money for a request ops cancelled is orphaned: the payment is kept, the request stays cancelled', async () => {
      const h = await make();
      const { booking, request, payment, event } = await seed(h);
      await h.addOns.cancel(request.id, cancelInput());

      const outcome = await h.settlement().acceptVerifiedEvent(event);

      expect(outcome.kind).toBe('add_on_orphaned');
      expect(outcome.payment).toMatchObject({ id: payment.id, status: 'succeeded' });
      if (outcome.kind !== 'add_on_orphaned') throw new Error('unreachable');
      expect(outcome.request).toMatchObject({ id: request.id, status: 'cancelled', paidAt: null });
      expect((await h.addOns.get(request.id))).toMatchObject({ status: 'cancelled', paidAt: null });
      expect((await paymentOf(h, payment.orderId)).status).toBe('succeeded');
      expect((await h.bookings.get(booking.id))?.status).toBe('paid');
    });

    it.each(['cancelled', 'refunded', 'no_show'] as const)(
      'money for an add-on on a %s booking is orphaned: the payment is kept, the request stays open',
      async (status) => {
        const h = await make();
        const { booking, request, payment, event } = await seed(h, status);

        const outcome = await h.settlement().acceptVerifiedEvent(event);

        expect(outcome.kind).toBe('add_on_orphaned');
        expect(outcome.payment.status).toBe('succeeded');
        if (outcome.kind !== 'add_on_orphaned') throw new Error('unreachable');
        expect(outcome.request).toMatchObject({ id: request.id, status: 'open' });
        expect((await h.addOns.get(request.id))).toMatchObject({ status: 'open', paidAt: null });
        expect((await paymentOf(h, payment.orderId)).status).toBe('succeeded');
        expect((await h.bookings.get(booking.id))?.status).toBe(status);
      },
    );

    it('an add-on payment with no request behind it is orphaned, with no request to name', async () => {
      const h = await make();
      const created = await h.bookings.create(single());
      await h.bookings.setStatus(created.id, 'payment_pending');
      const booking = await h.bookings.setStatus(created.id, 'paid');
      const { request, payment, event } = await addRequest(h, booking, false);

      const outcome = await h.settlement().acceptVerifiedEvent(event);

      expect(outcome.kind).toBe('add_on_orphaned');
      if (outcome.kind !== 'add_on_orphaned') throw new Error('unreachable');
      expect(outcome.request).toBeNull();
      expect((await paymentOf(h, payment.orderId)).status).toBe('succeeded');
      expect((await h.addOns.get(request.id))?.status).toBe('open');
    });

    it('a decline fails the payment and leaves the request open; a later approval on the same order settles it', async () => {
      const h = await make();
      const { booking, request, payment, event } = await seed(h);
      const repo = h.settlement();

      const declined = await repo.acceptVerifiedEvent(declineOf(event));
      expect(declined.kind).toBe('failed');
      expect(declined.payment).toMatchObject({ status: 'failed', purpose: 'add_on' });
      expect((await h.addOns.get(request.id))).toMatchObject({ status: 'open', paidAt: null });
      expect((await h.bookings.get(booking.id))?.status).toBe('paid');

      expect((await repo.acceptVerifiedEvent(event)).kind).toBe('add_on_settled');
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
      expect((await paymentOf(h, payment.orderId)).status).toBe('succeeded');
    });

    it('still refuses an amount that does not match the request', async () => {
      const h = await make();
      const { request, payment, event } = await seed(h);
      await expect(h.settlement().acceptVerifiedEvent({ ...event, amountCents: 2800 }))
        .rejects.toMatchObject({ code: 'amount_mismatch' });
      await expect(h.settlement().acceptVerifiedEvent({ ...event, amountCents: 2800 }))
        .rejects.toBeInstanceOf(PaymentSettlementError);
      expect((await paymentOf(h, payment.orderId)).status).toBe('pending');
      expect((await h.addOns.get(request.id))?.status).toBe('open');
      expect(await h.events.listForReconciliation(payment.id)).toHaveLength(0);
    });

    it('deposit, then an add-on, then the balance: the balance is still the second half of one sale', async () => {
      const h = await make();
      const created = await h.bookings.create(single({ total: 4_000, amountDueNow: 1_000 }));
      await h.bookings.setStatus(created.id, 'payment_pending');
      const repo = h.settlement();
      const deposit = await h.payments.create({
        bookingId: created.id, provider: 'payhere', orderId: `${created.reference}-D`, amount: 1_000, currency: 'USD',
        idempotencyKey: `checkout:${created.id}:deposit`, purpose: 'deposit',
      });
      expect((await repo.acceptVerifiedEvent(successFor(deposit))).kind).toBe('settled');
      const booking = (await h.bookings.get(created.id))!;

      const addOn = await addRequest(h, booking);
      expect((await repo.acceptVerifiedEvent(addOn.event)).kind).toBe('add_on_settled');
      expect((await h.bookings.get(created.id))).toMatchObject({ status: 'paid', amountDueNow: 1_000 });

      const balance = await h.payments.create({
        bookingId: created.id, provider: 'payhere', orderId: `${created.reference}-B`, amount: 3_000, currency: 'USD',
        idempotencyKey: `checkout:${created.id}:balance`, purpose: 'balance',
      });
      const outcome = await repo.acceptVerifiedEvent(successFor(balance));
      expect(outcome.kind).toBe('balance_settled');
      expect((await h.bookings.get(created.id))?.status).toBe('paid');
    });

    it('two add-on requests on one booking settle independently', async () => {
      const h = await make();
      const { booking, request, event } = await seed(h);
      const second = await (async () => {
        const [leg] = await h.addOns.listLegs(booking.id);
        const req = await h.addOns.createRequest({
          bookingId: booking.id, lines: [{ legId: leg.id, code: 'waiting', label: 'Waiting fee — Colombo Airport → Galle', amountCents: 1000 }],
          currency: 'USD', rateCardVersion: 'card-v1', createdBy: 'ops@ceylonhop.com', now: new Date(), fullyRefundedPaymentIds: [],
        });
        const payment = await h.payments.create({
          bookingId: booking.id, provider: 'payhere', orderId: `${booking.reference}-A${req.seq}`, amount: 1000, currency: 'USD',
          idempotencyKey: `checkout:${booking.id}:addon:${req.id}`, purpose: 'add_on',
        });
        await h.addOns.attachPayment(req.id, payment.id);
        return { req, event: successFor(payment) };
      })();
      const repo = h.settlement();
      expect((await repo.acceptVerifiedEvent(event)).kind).toBe('add_on_settled');
      expect((await h.addOns.get(second.req.id))?.status).toBe('open');
      const outcome = await repo.acceptVerifiedEvent(second.event);
      expect(outcome.kind).toBe('add_on_settled');
      if (outcome.kind !== 'add_on_settled') throw new Error('unreachable');
      expect(outcome.request.id).toBe(second.req.id);
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
    });

    it.each(['after_event_insert', 'after_payment_update', 'after_add_on_update'] as const)(
      'rolls back the payment, the request and the notice after a failure at %s, then a retry settles',
      async (point) => {
        const h = await make();
        const { request, payment, event } = await seed(h);
        const broken = h.settlement((at) => {
          if (at === point) throw new Error(`injected_${point}`);
        });

        await expect(broken.acceptVerifiedEvent(event)).rejects.toThrow(`injected_${point}`);
        expect((await paymentOf(h, payment.orderId)).status).toBe('pending');
        expect((await h.addOns.get(request.id))).toMatchObject({ status: 'open', paidAt: null });
        expect(await h.events.listForReconciliation(payment.id)).toHaveLength(0);

        expect((await h.settlement().acceptVerifiedEvent(event)).kind).toBe('add_on_settled');
        expect((await h.addOns.get(request.id))?.status).toBe('paid');
      },
    );

    // Settlement never reaches the trip's "booking update" step for an add-on.
    it('never runs the booking-update step for an add-on', async () => {
      const h = await make();
      const { event } = await seed(h);
      const seen: string[] = [];
      await h.settlement((at) => { seen.push(at); }).acceptVerifiedEvent(event);
      expect(seen).toEqual(['after_event_insert', 'after_payment_update', 'after_add_on_update']);
    });

    // A cancel and a settlement for the same request must end in exactly one of two states:
    // cancelled and the money orphaned, or paid and the cancel refused. These two pin each order.
    it('a cancel that lands while settlement is running, before it reads the request, orphans the money', async () => {
      const h = await make();
      const { request, payment, event } = await seed(h);
      const repo = h.settlement(async (at) => {
        if (at === 'after_payment_update') await h.addOns.cancel(request.id, cancelInput());
      });

      const outcome = await repo.acceptVerifiedEvent(event);

      expect(outcome.kind).toBe('add_on_orphaned');
      expect((await h.addOns.get(request.id))).toMatchObject({ status: 'cancelled', paidAt: null });
      expect((await paymentOf(h, payment.orderId)).status).toBe('succeeded');
    });

    it('a cancel that arrives once settlement has marked the request paid is refused', async () => {
      const h = await make();
      const { request, event } = await seed(h);
      let cancel: Promise<unknown> | undefined;
      const repo = h.settlement((at) => {
        // Not awaited: in Postgres it waits on the request row settlement holds, until the commit.
        if (at === 'after_add_on_update') cancel = h.addOns.cancel(request.id, cancelInput()).then(() => 'cancelled', (e) => e);
      });

      const outcome = await repo.acceptVerifiedEvent(event);

      expect(outcome.kind).toBe('add_on_settled');
      const refused = await cancel;
      expect(refused).toBeInstanceOf(AddOnError);
      expect((refused as AddOnError).code).toBe('already_paid');
      expect((await h.addOns.get(request.id))?.status).toBe('paid');
    });

    it('a request that settled can no longer be cancelled', async () => {
      const h = await make();
      const { request, event } = await seed(h);
      await h.settlement().acceptVerifiedEvent(event);
      await expect(h.addOns.cancel(request.id, cancelInput())).rejects.toMatchObject({ code: 'already_paid' });
    });
  });
}

addOnSettlementContract('InMemoryPaymentSettlementRepo: add-on payments', async () => {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const events = new InMemoryPaymentEventRepo();
  const addOns = new InMemoryAddOnRepo(bookings, payments);
  return {
    bookings, payments, events, addOns,
    settlement: (failureHook) => new InMemoryPaymentSettlementRepo({ bookings, payments, events, addOns }, failureHook),
  };
});

describe('InMemoryPaymentSettlementRepo without an add-on repo', () => {
  it('keeps the money and reports it orphaned rather than guessing', async () => {
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const events = new InMemoryPaymentEventRepo();
    const created = await bookings.create(single());
    await bookings.setStatus(created.id, 'payment_pending');
    await bookings.setStatus(created.id, 'paid');
    const payment = await payments.create({
      bookingId: created.id, provider: 'payhere', orderId: `${created.reference}-A1`, amount: 1000, currency: 'USD',
      idempotencyKey: `checkout:${created.id}:addon:r1`, purpose: 'add_on',
    });
    const outcome = await new InMemoryPaymentSettlementRepo({ bookings, payments, events }).acceptVerifiedEvent({
      provider: 'payhere', merchantId: '1234567', orderId: payment.orderId, providerTxnId: 'PAY-1', amountCents: 1000, currency: 'USD',
      status: 'succeeded', providerStatusCode: '2', receivedAt: new Date(), payloadSha256: 'a'.repeat(64),
      sanitizedPayload: { order_id: payment.orderId, status_code: '2' },
    });
    expect(outcome.kind).toBe('add_on_orphaned');
    expect(outcome.payment.status).toBe('succeeded');
    expect((await bookings.get(created.id))?.status).toBe('paid');
  });
});
