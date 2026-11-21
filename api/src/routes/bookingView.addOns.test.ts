// The customer's booking view carries its add-on requests (spec 2026-11-14 §7.4): what the manage
// page needs to draw a pay card, a paid line or an expired line, and nothing else.
import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryRefundRepo } from '../db/refundRepo';
import { InMemoryAddOnRepo, type AddOnRequest } from '../db/addOnRepo';
import { signBookingToken } from '../lib/bookingToken';

const SECRET = 'dev-booking-link-secret-change-me';
// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const customer = { firstName: 'Anna', lastName: 'Berg', email: 'anna@example.com', whatsapp: '+46700000000', country: 'Sweden' };
// Kandy → Ella → Yala → Galle, the customer taking Ella → Yala themselves: two legs we drive.
const trip = (dates: string[]): NewBooking => ({
  mode: 'trip',
  input: {
    stops: ['Kandy', 'Ella', 'Yala', 'Galle'], nights: [1, 1, 1, 0], dates,
    gaps: [1], pax: 2, vehicleType: 'car', serviceType: 'private', customer,
  },
  total: 24000, amountDueNow: 24000, currency: 'USD',
});

async function world(dates: string[] = [inDays(10), '', inDays(14)]) {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const refunds = new InMemoryRefundRepo(bookings, payments);
  const addOns = new InMemoryAddOnRepo(bookings, payments);
  const app = createApp({ bookings, payments, refunds, addOns });
  const created = await bookings.create(trip(dates));
  const tripPay = await payments.create({
    bookingId: created.id, provider: 'fake', orderId: created.reference, amount: created.total, currency: 'USD',
    idempotencyKey: `checkout:${created.id}`,
  });
  await bookings.setStatus(created.id, 'payment_pending');
  await payments.markSucceeded(tripPay.id);
  await bookings.setStatus(created.id, 'paid');
  const legs = (await addOns.listLegs(created.id)).filter((l) => l.kind === 'leg');
  const send = (lines: Array<{ leg: number; code: string; label: string; amountCents: number }>): Promise<AddOnRequest> =>
    addOns.createRequest({
      bookingId: created.id, lines: lines.map(({ leg, ...l }) => ({ ...l, legId: legs[leg]!.id })), currency: 'USD',
      rateCardVersion: 'card-v1', createdBy: 'ops@ceylonhop.com', now: new Date(), fullyRefundedPaymentIds: [],
    });
  const view = async (): Promise<Record<string, unknown> & { addOnRequests?: Array<Record<string, unknown>> }> => {
    const res = await app.request(`/bookings/view?t=${encodeURIComponent(signBookingToken(created.id, SECRET))}`);
    expect(res.status).toBe(200);
    return res.json();
  };
  return { bookings, payments, refunds, addOns, created, legs, send, view };
}
const WAIT = { code: 'waiting', label: 'Waiting fee — Kandy → Ella', amountCents: 500 };
const SIGHT = { code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Yala → Galle', amountCents: 1000 };

describe('GET /bookings/view: addOnRequests', () => {
  it('is an empty list for a booking with no requests, and no other field moves', async () => {
    const w = await world();
    const v = await w.view();
    expect(v.addOnRequests).toEqual([]);
    expect(v).toMatchObject({ totalCents: 24000, paidCents: 24000, balanceDueCents: 0, status: 'paid' });
  });

  it('returns a payable request in exactly the agreed shape, payBy = its earliest dated leg', async () => {
    const w = await world();
    await w.send([{ leg: 1, ...SIGHT }, { leg: 0, ...WAIT }]);
    const v = await w.view();
    expect(v.addOnRequests).toEqual([{
      id: expect.any(String), state: 'awaiting_payment', totalCents: 1500, currency: 'USD', payable: true,
      payBy: inDays(10),
      lines: [{ label: WAIT.label, amountCents: 500 }, { label: SIGHT.label, amountCents: 1000 }],
    }]);
  });

  it('payBy is null when none of the request\'s legs is dated', async () => {
    const w = await world(['', '', '']);
    await w.send([{ leg: 0, ...WAIT }]);
    const [r] = (await w.view()).addOnRequests!;
    expect(r).toMatchObject({ state: 'awaiting_payment', payable: true, payBy: null });
  });

  it('leaves cancelled requests out and keeps the others in request order', async () => {
    const w = await world();
    const first = await w.send([{ leg: 0, ...WAIT }]);
    await w.addOns.cancel(first.id, { by: 'ops@ceylonhop.com', reason: 'Asked us to', now: new Date(), inFlightAfter: new Date() });
    const second = await w.send([{ leg: 1, ...SIGHT }]);
    const list = (await w.view()).addOnRequests!;
    expect(list.map((r) => r.id)).toEqual([second.id]);
  });

  it('exposes nothing private: no names, reasons, payment ids, leg ids, orders or links', async () => {
    const w = await world();
    const req = await w.send([{ leg: 0, ...WAIT }]);
    const pay = await w.payments.create({
      bookingId: w.created.id, provider: 'fake', orderId: `${w.created.reference}-A1`, amount: 500, currency: 'USD',
      idempotencyKey: `checkout:${w.created.id}:addon:${req.id}`, purpose: 'add_on',
    });
    await w.addOns.attachPayment(req.id, pay.id);
    const [r] = (await w.view()).addOnRequests!;
    expect(Object.keys(r!).sort()).toEqual(['currency', 'id', 'lines', 'payBy', 'payable', 'state', 'totalCents']);
    expect(Object.keys((r!.lines as object[])[0]!).sort()).toEqual(['amountCents', 'label']);
    const json = JSON.stringify(r);
    for (const secret of ['ops@ceylonhop.com', pay.id, w.legs[0]!.id, `${w.created.reference}-A1`, 'payLink']) {
      expect(json).not.toContain(secret);
    }
  });

  it('reads a paid request as paid, and a fully refunded one as refunded', async () => {
    const w = await world();
    const req = await w.send([{ leg: 0, ...WAIT }]);
    const pay = await w.payments.create({
      bookingId: w.created.id, provider: 'fake', orderId: `${w.created.reference}-A1`, amount: 500, currency: 'USD',
      idempotencyKey: `checkout:${w.created.id}:addon:${req.id}`, purpose: 'add_on',
    });
    await w.addOns.attachPayment(req.id, pay.id);
    await w.payments.markSucceeded(pay.id);
    w.addOns.markPaidForSettlement(req.id, new Date());
    const paid = (await w.view()).addOnRequests![0]!;
    expect(paid).toMatchObject({ state: 'paid', payable: false });
    // Trip figures stay the trip's.
    expect(await w.view()).toMatchObject({ totalCents: 24000, paidCents: 24000 });

    const r = await w.refunds.request({
      bookingId: w.created.id, amountCents: 500, currency: 'USD', reason: 'No longer wanted', requestedBy: 'ops@ceylonhop.com', paymentId: pay.id,
    });
    await w.refunds.confirm({ bookingId: w.created.id, refundId: r.id, gatewayRef: 'rf-1', confirmedBy: 'founder@ceylonhop.com' });
    expect((await w.view()).addOnRequests![0]).toMatchObject({ state: 'refunded' });
  });

  it('reads a request whose leg day has passed as expired, not payable, still showing its earliest day', async () => {
    const w = await world([inDays(-3), '', inDays(14)]);
    await w.send([{ leg: 0, ...WAIT }]);
    expect((await w.view()).addOnRequests).toEqual([expect.objectContaining({
      state: 'expired', payable: false, payBy: inDays(-3),
    })]);
  });
});
