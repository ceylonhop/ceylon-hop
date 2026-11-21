// Add-ons after booking (spec 2026-11-14 §4, §7.1): the service the ops routes call. The route
// tests (routes/ops.addOns.test.ts) cover every error code over HTTP; these cover what is awkward
// to reach from a request: time passing, refunds on the add-on's own payment, a checkout in flight.
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryBookingRepo, type Booking, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { InMemoryAddOnRepo, type AddOnRequest } from '../db/addOnRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { EXTRA_CODES, RATE_CARD } from '../quote/rateCard';
import { EXTRA_LABELS } from '../quote/extrasDeposit';
import { CHECKOUT_TOKEN_TTL_MS } from '../lib/bookingToken';
import { addOnOrderId, addOnIdempotencyKey } from '../domain/addOns';
import {
  addOnPayBy, addOnRequestViews, cancelAddOnRequest, createAddOnRequest, type AddOnDeps,
} from './addOns';

const customer = { firstName: 'Anna', lastName: 'Berg', email: 'anna@example.com', whatsapp: '+46700000000', country: 'Sweden' };

// Relative dates: a fixed calendar date in a test is a time bomb.
const DAY = 86_400_000;
const inDays = (n: number) => new Date(Date.now() + n * DAY).toISOString().slice(0, 10);

// Kandy → Ella → Yala → Galle, the customer taking Ella → Yala themselves: two legs we drive.
const trip = (dates = [inDays(10), '', inDays(14)]): NewBooking => ({
  mode: 'trip',
  input: {
    stops: ['Kandy', 'Ella', 'Yala', 'Galle'], nights: [1, 1, 1, 0], dates,
    gaps: [1], pax: 2, vehicleType: 'car', serviceType: 'private', customer,
  },
  total: 24000, amountDueNow: 24000, currency: 'USD',
});

const single = (over: Partial<Extract<NewBooking, { mode: 'single' }>['input']> = {}): NewBooking => ({
  mode: 'single',
  input: {
    from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2,
    date: inDays(10), time: '09:00', customer, ...over,
  },
  total: 12100, amountDueNow: 12100, currency: 'USD',
});

describe('add-ons after booking: the service', () => {
  let bookings: InMemoryBookingRepo;
  let payments: InMemoryPaymentRepo;
  let refunds: InMemoryRefundRepo;
  let addOns: InMemoryAddOnRepo;
  let email: FakeEmailAdapter;
  let deps: AddOnDeps;

  beforeEach(() => {
    bookings = new InMemoryBookingRepo();
    payments = new InMemoryPaymentRepo();
    refunds = new InMemoryRefundRepo(bookings, payments);
    addOns = new InMemoryAddOnRepo(bookings, payments);
    email = new FakeEmailAdapter();
    deps = {
      addOns, payments, refunds, email,
      rateCard: async () => RATE_CARD,
      baseUrl: 'https://pay.example', linkSecret: 'sek',
    };
  });

  // A booking the customer has paid for: the trip's own payment is on the ledger, as it is in life.
  async function paid(nb: NewBooking = trip()): Promise<Booking> {
    const b = await bookings.create(nb);
    await bookings.setStatus(b.id, 'payment_pending');
    const p = await payments.create({
      bookingId: b.id, provider: 'fake', orderId: b.reference, amount: b.total, currency: 'USD', idempotencyKey: `checkout:${b.id}`,
    });
    await payments.markSucceeded(p.id);
    return bookings.setStatus(b.id, 'paid');
  }
  const drivenLegs = async (b: Booking) => (await addOns.listLegs(b.id)).filter((l) => l.kind === 'leg');
  const send = async (b: Booking, lines: Array<{ legId: string; code: string }>, notifyCustomer = false) => {
    const res = await createAddOnRequest(deps, b, { lines, notifyCustomer, createdBy: 'ops@ceylonhop.com', now: new Date() });
    if (!res.ok) throw new Error(`expected a request, got ${res.error}`);
    return res;
  };
  // The checkout Task 4 will build: the request's own payment row, attached to it.
  async function addOnPayment(b: Booking, req: { id: string; seq: number; totalCents: number }) {
    const p = await payments.create({
      bookingId: b.id, provider: 'fake', orderId: addOnOrderId(b.reference, req.seq), amount: req.totalCents,
      currency: 'USD', idempotencyKey: addOnIdempotencyKey(b.id, req.id), purpose: 'add_on',
    });
    await addOns.attachPayment(req.id, p.id);
    return p;
  }
  async function settle(b: Booking, req: { id: string; seq: number; totalCents: number }) {
    const p = await addOnPayment(b, req);
    await payments.markSucceeded(p.id);
    addOns.markPaidForSettlement(req.id, new Date());
    return p;
  }
  async function refund(b: Booking, paymentId: string, amountCents: number) {
    const r = await refunds.request({ bookingId: b.id, amountCents, currency: 'USD', reason: 'not wanted', requestedBy: 'f@x.com', paymentId });
    await refunds.confirm({ bookingId: b.id, refundId: r.id, gatewayRef: `rf-${r.id}`, confirmedBy: 'f@x.com' });
  }
  const view = async (b: Booking, now = new Date()) => addOnRequestViews(deps, (await bookings.get(b.id))!, { now });

  // `isPrivateBooking` reads serviceType at the top level, and a Booking holds it at
  // input.serviceType: handed the booking as it is, a private trip reads as not private.
  it('a private multi-leg trip can take an add-on, priced and labelled by the server', async () => {
    const b = await paid();
    const [kandyElla, yalaGalle] = await drivenLegs(b);
    const res = await send(b, [{ legId: yalaGalle!.id, code: 'safari-wait' }, { legId: kandyElla!.id, code: 'waiting' }]);
    expect(res.emailed).toBe(false);
    expect(res.request).toMatchObject({
      seq: 1, name: 'A1', status: 'open', state: 'awaiting_payment', payable: true, currency: 'USD',
      orderId: `${b.reference}-A1`, createdBy: 'ops@ceylonhop.com', refundedCents: 0, inFlightUntil: null,
      totalCents: RATE_CARD.extras.waiting + RATE_CARD.extras['safari-wait'],
    });
    expect(res.request.lines.map((l) => [l.legId, l.code, l.label, l.amountCents])).toEqual([
      [kandyElla!.id, 'waiting', 'Waiting fee — Kandy → Ella', RATE_CARD.extras.waiting],
      [yalaGalle!.id, 'safari-wait', 'Wait for Safari — Yala → Galle', RATE_CARD.extras['safari-wait']],
    ]);
    const stored = (await addOns.listByBooking(b.id))[0]!;
    expect(stored.rateCardVersion).toBe(RATE_CARD.version);
  });

  it('a chauffeur trip is not private', async () => {
    const b = await paid({ ...trip(), input: { ...trip().input, serviceType: 'chauffeur', gaps: [], days: 4 } } as NewBooking);
    const legs = await addOns.listLegs(b.id);
    const res = await createAddOnRequest(deps, b, { lines: [{ legId: legs[0]!.id, code: 'waiting' }], notifyCustomer: false, createdBy: 'o@x.com', now: new Date() });
    expect(res).toEqual({ ok: false, error: 'not_private' });
    expect((await view(b)).addOnCatalogue).toBeUndefined();
  });

  it('names the leg by its short place names, not the full address', async () => {
    const b = await paid(single({ from: 'The Den 23, Norris Canal Road, Colombo, Sri Lanka', to: 'Galle Fort, Galle, Sri Lanka' }));
    const [leg] = await drivenLegs(b);
    const res = await send(b, [{ legId: leg!.id, code: 'luggage' }]);
    expect(res.request.lines[0]!.label).toBe('Luggage rack — The Den 23 · Colombo → Galle Fort');
  });

  it('the views carry the stored legs, and the catalogue only while a request can be created', async () => {
    const b = await paid();
    const v = await view(b);
    expect(v.legs.map((l) => [l.seq, l.kind, l.from, l.to])).toEqual([
      [1, 'leg', 'Kandy', 'Ella'], [2, 'gap', 'Ella', 'Yala'], [3, 'leg', 'Yala', 'Galle'],
    ]);
    expect(v.addOnRequests).toEqual([]);
    // Every private add-on at the card's price; never the shared-only hotel pick-up / drop-off.
    expect(v.addOnCatalogue).toEqual(
      EXTRA_CODES.map((code) => ({ code, label: EXTRA_LABELS[code], priceCents: RATE_CARD.extras[code] })),
    );
    const [leg] = await drivenLegs(b);
    await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    await bookings.setStatus(b.id, 'confirmed');
    await bookings.setStatus(b.id, 'in_progress');
    await bookings.setStatus(b.id, 'completed');
    const done = await view(b);
    expect(done.addOnCatalogue).toBeUndefined();
    expect(done.addOnRequests).toHaveLength(1);
  });

  it('a request is payable to the end of its leg’s day (Sri Lanka time), then shows as expired', async () => {
    const b = await paid(single({ date: inDays(3) }));
    const [leg] = await drivenLegs(b);
    const { request } = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    expect(request.payLink).toMatch(/^https:\/\/pay\.example\/manage\.html\?t=.+#add-ons$/);

    // 12:00 UTC is 17:30 in Colombo: still the leg's day there.
    const onTheDay = (await view(b, new Date(`${inDays(3)}T12:00:00Z`))).addOnRequests[0]!;
    expect(onTheDay).toMatchObject({ state: 'awaiting_payment', payable: true });
    expect(onTheDay.payLink).toBe(request.payLink);

    // 19:00 UTC is 00:30 the next day in Colombo.
    const after = (await view(b, new Date(`${inDays(3)}T19:00:00Z`))).addOnRequests[0]!;
    expect(after).toMatchObject({ status: 'open', state: 'expired', payable: false, payLink: null });
  });

  it('an open request on a cancelled booking shows as cancelled with the booking', async () => {
    const b = await paid();
    const [leg] = await drivenLegs(b);
    await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    await bookings.setStatus(b.id, 'cancelled');
    expect((await view(b)).addOnRequests[0]).toMatchObject({ state: 'cancelled_with_booking', payable: false, payLink: null });
  });

  it('shows a checkout in flight until 30 minutes after its last attempt, and refuses to cancel meanwhile', async () => {
    const b = await paid();
    const [leg] = await drivenLegs(b);
    const { request } = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    const p = await addOnPayment(b, request);
    expect((await view(b)).addOnRequests[0]!.inFlightUntil).toBeNull(); // a row, but no checkout started
    await payments.touchAttempt(p.id);
    const attempt = (await payments.findByBookingId(b.id)).find((x) => x.id === p.id)!.lastAttemptAt!;
    const until = new Date(attempt.getTime() + CHECKOUT_TOKEN_TTL_MS);

    expect((await view(b)).addOnRequests[0]!.inFlightUntil).toBe(until.toISOString());
    expect(await cancelAddOnRequest(deps, b, request.id, { by: 'o@x.com', reason: 'changed mind', now: new Date() }))
      .toEqual({ ok: false, error: 'payment_in_flight' });

    const later = new Date(until.getTime() + 1000);
    expect((await view(b, later)).addOnRequests[0]!.inFlightUntil).toBeNull();
    const res = await cancelAddOnRequest(deps, b, request.id, { by: 'o@x.com', reason: 'changed mind', now: later });
    expect(res.ok && res.request).toMatchObject({
      status: 'cancelled', state: 'cancelled', payable: false, payLink: null, inFlightUntil: null,
      cancelledBy: 'o@x.com', cancelledAt: later.toISOString(), cancelReason: 'changed mind',
    });
  });

  // The ops pane labels a payment row "Add-on A1" by matching it to its request (spec §7.2).
  it('a request names its own payment row once a checkout made one, and null before that', async () => {
    const b = await paid();
    const [leg, other] = await drivenLegs(b);
    const sent = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    expect(sent.request.paymentId).toBeNull();
    expect((await view(b)).addOnRequests[0]!.paymentId).toBeNull();

    const p = await addOnPayment(b, sent.request);
    const second = await send(b, [{ legId: other!.id, code: 'waiting' }]);
    const views = (await view(b)).addOnRequests;
    expect(views.map((r) => [r.name, r.paymentId])).toEqual([['A1', p.id], ['A2', null]]);
    expect(second.request.paymentId).toBeNull();
    // Never the trip's own payment.
    const tripPayment = (await payments.findByBookingId(b.id)).find((x) => x.purpose === 'full')!;
    expect(views.some((r) => r.paymentId === tripPayment.id)).toBe(false);
  });

  it('keeps naming its payment after it is paid, and after it is cancelled', async () => {
    const b = await paid();
    const [leg, other] = await drivenLegs(b);
    const first = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    const paidRow = await settle(b, first.request);
    const second = await send(b, [{ legId: other!.id, code: 'waiting' }]);
    const abandoned = await addOnPayment(b, second.request);
    const res = await cancelAddOnRequest(deps, b, second.request.id, { by: 'o@x.com', reason: 'changed mind', now: new Date() });
    expect(res.ok && res.request.paymentId).toBe(abandoned.id);
    expect((await view(b)).addOnRequests.map((r) => [r.state, r.paymentId])).toEqual([['paid', paidRow.id], ['cancelled', abandoned.id]]);
  });

  it('reads refunds off the add-on’s own payment: part refunded, then refunded', async () => {
    const b = await paid();
    const [leg] = await drivenLegs(b);
    const { request } = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    const p = await settle(b, request);
    expect((await view(b)).addOnRequests[0]).toMatchObject({ status: 'paid', state: 'paid', refundedCents: 0, payable: false, payLink: null });
    expect((await view(b)).addOnRequests[0]!.paidAt).toEqual(expect.any(String));

    await refund(b, p.id, 400);
    expect((await view(b)).addOnRequests[0]).toMatchObject({ state: 'part_refunded', refundedCents: 400 });
    await refund(b, p.id, 600);
    expect((await view(b)).addOnRequests[0]).toMatchObject({ state: 'refunded', refundedCents: 1000 });
  });

  it('a refund on the trip’s own payment is not the add-on’s', async () => {
    const b = await paid();
    const [leg] = await drivenLegs(b);
    const { request } = await send(b, [{ legId: leg!.id, code: 'waiting' }]);
    await settle(b, request);
    const tripPayment = (await payments.findByBookingId(b.id)).find((x) => x.purpose === 'full')!;
    await refund(b, tripPayment.id, 5000);
    expect((await view(b)).addOnRequests[0]).toMatchObject({ state: 'paid', refundedCents: 0 });
  });

  it('the same add-on can be sent again only once the first one’s payment is fully refunded', async () => {
    const b = await paid();
    const [leg] = await drivenLegs(b);
    const line = [{ legId: leg!.id, code: 'waiting' }];
    const { request } = await send(b, line);
    const p = await settle(b, request);
    const again = () => createAddOnRequest(deps, b, { lines: line, notifyCustomer: false, createdBy: 'o@x.com', now: new Date() });

    expect(await again()).toEqual({ ok: false, error: 'duplicate_add_on' });
    await refund(b, p.id, 400);
    expect(await again()).toEqual({ ok: false, error: 'duplicate_add_on' });
    await refund(b, p.id, 600);
    const second = await again();
    expect(second.ok && second.request).toMatchObject({ seq: 2, name: 'A2', orderId: `${b.reference}-A2` });
  });

  it('emails the pay link when asked, with the earliest leg day as the pay-by date', async () => {
    const b = await paid();
    const [kandyElla, yalaGalle] = await drivenLegs(b);
    const res = await send(b, [{ legId: yalaGalle!.id, code: 'waiting' }, { legId: kandyElla!.id, code: 'sightseeing' }], true);
    expect(res.emailed).toBe(true);
    expect(email.sent).toHaveLength(1);
    const m = email.sent[0]!;
    expect(m.to).toBe('anna@example.com');
    expect(m.html).toContain(res.request.payLink!);
    expect(m.tracking).toMatchObject({ kind: 'add_on_request', trackingKey: `${b.id}:add_on_request:${res.request.id}` });
  });

  it('addOnPayBy is the earliest dated leg of the request, or null when none is dated', async () => {
    const legs = [
      { id: 'a', seq: 1, kind: 'leg', from: 'Kandy', to: 'Ella', viaStops: [], travelDate: '2026-12-14' },
      { id: 'b', seq: 2, kind: 'leg', from: 'Ella', to: 'Yala', viaStops: [], travelDate: '2026-12-10' },
      { id: 'c', seq: 3, kind: 'leg', from: 'Yala', to: 'Galle', viaStops: [], travelDate: null },
    ];
    const req = (ids: string[]) => ({ lines: ids.map((legId) => ({ legId })) }) as Pick<AddOnRequest, 'lines'>;
    expect(addOnPayBy(req(['a', 'b', 'c']), legs)).toBe('2026-12-10');
    expect(addOnPayBy(req(['a']), legs)).toBe('2026-12-14');
    expect(addOnPayBy(req(['c']), legs)).toBeNull();
  });
});
