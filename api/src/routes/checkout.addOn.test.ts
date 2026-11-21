import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createApp } from '../app';
import { InMemoryBookingRepo, type NewBooking } from '../db/bookingRepo';
import { InMemoryPaymentRepo } from '../db/paymentRepo';
import { InMemoryPromoCodeRepo } from '../db/promoCodeRepo';
import { InMemoryAddOnRepo, type AddOnRequest } from '../db/addOnRepo';
import { signBookingToken, signCheckoutToken, signPayReturnToken, verifyCheckoutToken, verifyPayReturnLeg } from '../lib/bookingToken';
import { FakePaymentAdapter, type PaymentAdapter, type CreateCheckoutArgs } from '../adapters/payments';

// Paying for an add-on request online (spec 2026-11-14 §6.2). A third checkout lane beside the
// trip's own and the balance: REF-A<seq> / checkout:<bookingId>:addon:<requestId>, charging the
// request's frozen total on a booking that is already secured. It never touches the booking.

const SECRET = 'dev-booking-link-secret-change-me';
const TOTAL = 12100;
const customer = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };
// Relative dates: a fixed calendar date in a test is a time bomb.
const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const single = (date: string = inDays(10)): NewBooking => ({
  mode: 'single',
  input: { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, date, time: '09:00', customer },
  total: TOTAL, amountDueNow: TOTAL, currency: 'USD',
});

type Status = 'paid' | 'confirmed' | 'in_progress' | 'completed' | 'cancelled';

function spy() {
  const inner = new FakePaymentAdapter();
  const box: { seen: CreateCheckoutArgs | null } = { seen: null };
  const adapter: PaymentAdapter = {
    provider: inner.provider,
    createCheckout: (args) => { box.seen = args; return inner.createCheckout(args); },
    parseWebhook: (raw) => inner.parseWebhook(raw),
  };
  return { adapter, box };
}

async function world(opts: { status?: Status; date?: string; payBaseUrl?: string } = {}) {
  const bookings = new InMemoryBookingRepo();
  const payments = new InMemoryPaymentRepo();
  const addOns = new InMemoryAddOnRepo(bookings, payments);
  const { adapter, box } = spy();
  const app = createApp({
    bookings, payments, addOns, adapter, bookingBaseUrl: 'https://site.example.com',
    ...(opts.payBaseUrl ? { payBaseUrl: opts.payBaseUrl } : {}),
  });

  // A paid private transfer: the trip's own payment has succeeded.
  const paidBooking = async (nb: NewBooking = single(opts.date)) => {
    const created = await bookings.create(nb);
    const trip = await payments.create({
      bookingId: created.id, provider: adapter.provider, orderId: created.reference, amount: created.total, currency: 'USD',
      idempotencyKey: `checkout:${created.id}`,
    });
    await bookings.setStatus(created.id, 'payment_pending');
    await payments.markSucceeded(trip.id);
    await bookings.setStatus(created.id, 'paid');
    return created;
  };
  const sendRequest = async (bookingId: string, lines: Array<{ code: string; label: string; amountCents: number }> = [
    { code: 'sightseeing', label: 'Sightseeing stops (up to 3h) — Colombo Airport → Galle', amountCents: 1000 },
  ]): Promise<AddOnRequest> => {
    const [leg] = await addOns.listLegs(bookingId);
    return addOns.createRequest({
      bookingId, lines: lines.map((l) => ({ ...l, legId: leg.id })), currency: 'USD', rateCardVersion: 'card-v1',
      createdBy: 'ops@ceylonhop.com', now: new Date(), fullyRefundedPaymentIds: [],
    });
  };

  const created = await paidBooking();
  const request = await sendRequest(created.id);
  const status = opts.status ?? 'paid';
  if (status === 'cancelled') await bookings.setStatus(created.id, 'cancelled');
  if (status === 'confirmed' || status === 'in_progress' || status === 'completed') await bookings.setStatus(created.id, 'confirmed');
  if (status === 'in_progress' || status === 'completed') await bookings.setStatus(created.id, 'in_progress');
  if (status === 'completed') await bookings.setStatus(created.id, 'completed');

  const b = { id: created.id, reference: created.reference };
  const checkout = (body: unknown, bookingId: string = b.id, origin?: string) =>
    app.request(`/bookings/${bookingId}/checkout`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${signCheckoutToken(bookingId, SECRET, Date.now())}`, 'content-type': 'application/json',
        ...(origin ? { origin } : {}),
      },
      body: JSON.stringify(body),
    });
  const addOnCheckout = (requestId: string = request.id, extra: Record<string, unknown> = {}, origin?: string) =>
    checkout({ purpose: 'add_on', addOnRequestId: requestId, returnTo: 'manage', ...extra }, b.id, origin);
  const checkoutToken = (body?: unknown, bookingId: string = b.id) =>
    app.request('/bookings/view/checkout-token', {
      method: 'POST',
      headers: { authorization: `Bearer ${signBookingToken(bookingId, SECRET)}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const payReturn = (rt: string) => app.request(`/bookings/pay-return?rt=${encodeURIComponent(rt)}`);
  const addOnRows = async () => (await payments.findByBookingId(b.id)).filter((p) => p.purpose === 'add_on');
  return { app, bookings, payments, addOns, box, b, request, paidBooking, sendRequest, checkout, addOnCheckout, checkoutToken, payReturn, addOnRows };
}

const refusal = async (res: Response | Promise<Response>) => {
  const r = await res;
  return [r.status, (await r.json()).error];
};

describe('POST /bookings/:id/checkout: purpose add_on', () => {
  it('charges the request total on REF-A<seq> with its own key and purpose, and ties the row to the request', async () => {
    const w = await world();
    const res = await w.addOnCheckout();
    expect(res.status).toBe(200);
    const params = await res.json();
    expect(params.amount).toBe(1000);
    expect(params.orderId).toBe(`${w.b.reference}-A1`);
    expect(w.box.seen).toMatchObject({ orderId: `${w.b.reference}-A1`, amount: 1000, currency: 'USD' });
    const rows = await w.addOnRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      amount: 1000, currency: 'USD', orderId: `${w.b.reference}-A1`, purpose: 'add_on', status: 'pending',
      idempotencyKey: `checkout:${w.b.id}:addon:${w.request.id}`, attemptCount: 1,
    });
    expect((await w.addOns.get(w.request.id))?.paymentId).toBe(rows[0].id);
    // The trip's own payment row is untouched.
    expect(await w.payments.findByBookingId(w.b.id)).toHaveLength(2);
  });

  it('never touches the booking: status, amount due now and total stay as they were', async () => {
    const w = await world();
    const before = await w.bookings.get(w.b.id);
    expect((await w.addOnCheckout()).status).toBe(200);
    const after = await w.bookings.get(w.b.id);
    expect(after?.status).toBe('paid');
    expect(after?.amountDueNow).toBe(before?.amountDueNow);
    expect(after?.total).toBe(TOTAL);
  });

  it('a second call resumes the same row and counts the attempt', async () => {
    const w = await world();
    expect((await (await w.addOnCheckout()).json()).attempt).toBe(1);
    const again = await w.addOnCheckout();
    expect(again.status).toBe(200);
    expect((await again.json()).attempt).toBe(2);
    const rows = await w.addOnRows();
    expect(rows).toHaveLength(1);
    expect(rows[0].attemptCount).toBe(2);
  });

  it('charges the sum of a request with several lines, once', async () => {
    const w = await world();
    const both = await w.sendRequest(w.b.id, [
      { code: 'waiting', label: 'Waiting fee — Colombo Airport → Galle', amountCents: 1000 },
      { code: 'safari-wait', label: 'Wait for Safari — Colombo Airport → Galle', amountCents: 1900 },
    ]);
    const params = await (await w.addOnCheckout(both.id)).json();
    expect(params.amount).toBe(2900);
    expect(params.orderId).toBe(`${w.b.reference}-A2`);
  });

  it('the client cannot send an amount', async () => {
    const w = await world();
    const params = await (await w.addOnCheckout(w.request.id, { amount: 1 })).json();
    expect(params.amount).toBe(1000);
  });

  it.each(['confirmed', 'in_progress', 'completed'] as const)('is open on a %s booking too', async (status) => {
    const w = await world({ status });
    expect((await w.addOnCheckout()).status).toBe(200);
    expect((await w.bookings.get(w.b.id))?.status).toBe(status);
  });

  it('409 add_on_not_payable once the leg’s day has passed, and no payment row is made', async () => {
    const w = await world({ date: inDays(-2) });
    expect(await refusal(w.addOnCheckout())).toEqual([409, 'add_on_not_payable']);
    expect(await w.addOnRows()).toHaveLength(0);
    expect((await w.addOns.get(w.request.id))?.paymentId).toBeNull();
  });

  it('409 add_on_not_payable for a request ops cancelled', async () => {
    const w = await world();
    await w.addOns.cancel(w.request.id, { by: 'ops@ceylonhop.com', reason: 'changed their mind', now: new Date(), inFlightAfter: new Date(0) });
    expect(await refusal(w.addOnCheckout())).toEqual([409, 'add_on_not_payable']);
    expect(await w.addOnRows()).toHaveLength(0);
  });

  it('409 add_on_not_payable once the booking is cancelled', async () => {
    const w = await world({ status: 'cancelled' });
    expect(await refusal(w.addOnCheckout())).toEqual([409, 'add_on_not_payable']);
    expect(await w.addOnRows()).toHaveLength(0);
  });

  it('409 already_paid, in the lane’s existing shape, once the request is paid', async () => {
    const w = await world();
    await w.addOnCheckout();
    const [row] = await w.addOnRows();
    await w.payments.markSucceeded(row.id);
    w.addOns.markPaidForSettlement(w.request.id, new Date());
    const res = await w.addOnCheckout();
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'already_paid', status: 'paid' });
  });

  it('409 already_paid when the money landed but the request was not marked yet', async () => {
    const w = await world();
    await w.addOnCheckout();
    const [row] = await w.addOnRows();
    await w.payments.markSucceeded(row.id);
    expect(await refusal(w.addOnCheckout())).toEqual([409, 'already_paid']);
  });

  it('404 for a request that belongs to another booking', async () => {
    const w = await world();
    const other = await w.paidBooking();
    const theirs = await w.sendRequest(other.id);
    expect(await refusal(w.addOnCheckout(theirs.id))).toEqual([404, 'not_found']);
    expect(await w.addOnRows()).toHaveLength(0);
    expect((await w.payments.findByBookingId(other.id)).filter((p) => p.purpose === 'add_on')).toHaveLength(0);
  });

  it('404 for an unknown, missing or malformed request id, and never falls back to charging the trip', async () => {
    const w = await world();
    expect(await refusal(w.addOnCheckout(randomUUID()))).toEqual([404, 'not_found']);
    expect(await refusal(w.checkout({ purpose: 'add_on' }))).toEqual([404, 'not_found']);
    expect(await refusal(w.checkout({ purpose: 'add_on', addOnRequestId: 'nope' }))).toEqual([404, 'not_found']);
    expect(await refusal(w.checkout({ purpose: 'add_on', addOnRequestId: 7 }))).toEqual([404, 'not_found']);
    expect(await w.payments.findByBookingId(w.b.id)).toHaveLength(1);
  });

  it('409 amount_mismatch when an existing row no longer matches the request', async () => {
    const w = await world();
    await w.payments.create({
      bookingId: w.b.id, provider: 'fake', orderId: `${w.b.reference}-A1`, amount: 100, currency: 'USD',
      idempotencyKey: `checkout:${w.b.id}:addon:${w.request.id}`, purpose: 'add_on',
    });
    expect(await refusal(w.addOnCheckout())).toEqual([409, 'amount_mismatch']);
  });

  it('still needs a checkout token for this booking', async () => {
    const w = await world();
    const res = await w.app.request(`/bookings/${w.b.id}/checkout`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'add_on', addOnRequestId: w.request.id }),
    });
    expect(res.status).toBe(401);
  });

  it('the return and cancel URLs come back to the manage page and name this request', async () => {
    const w = await world();
    const params = await (await w.addOnCheckout()).json();
    expect(w.box.seen!.returnUrl).toMatch(/^https:\/\/site\.example\.com\/manage\.html\?rt=/);
    expect(w.box.seen!.cancelUrl).toMatch(/&c=1$/);
    const rt = (url: string) => new URL(url).searchParams.get('rt') ?? undefined;
    expect(verifyPayReturnLeg(rt(w.box.seen!.returnUrl!), SECRET)).toEqual({ bookingId: w.b.id, leg: 'return', addOnSeq: 1 });
    expect(verifyPayReturnLeg(rt(w.box.seen!.cancelUrl!), SECRET)).toEqual({ bookingId: w.b.id, leg: 'cancel', addOnSeq: 1 });
    expect(verifyPayReturnLeg(params.payReturnToken, SECRET)).toEqual({ bookingId: w.b.id, leg: 'return', addOnSeq: 1 });
  });

  // Staging, 2026-11-21 (CH-TPSMY): the ops pane's pay link opened manage.html on the pay host,
  // and PayHere brought the customer back to the customer site's host instead — on staging a
  // sign-in wall, and anywhere a tab whose sessionStorage has no manage token. The page is served
  // on both of our hosts, so the customer goes back to the one they paid from.
  it('brings the customer back to the host they paid from when that is the pay host', async () => {
    const w = await world({ payBaseUrl: 'https://pay.example.com' });
    expect((await w.addOnCheckout(w.request.id, {}, 'https://pay.example.com')).status).toBe(200);
    expect(w.box.seen!.returnUrl).toMatch(/^https:\/\/pay\.example\.com\/manage\.html\?rt=[^&]+$/);
    expect(w.box.seen!.cancelUrl).toMatch(/^https:\/\/pay\.example\.com\/manage\.html\?rt=[^&]+&c=1$/);
  });

  it('keeps the customer site for a checkout from the site, from no stated origin, and from anyone else’s', async () => {
    for (const origin of ['https://site.example.com', undefined, 'https://evil.example']) {
      const w = await world({ payBaseUrl: 'https://pay.example.com' });
      expect((await w.addOnCheckout(w.request.id, {}, origin)).status).toBe(200);
      expect(w.box.seen!.returnUrl).toMatch(/^https:\/\/site\.example\.com\/manage\.html\?rt=/);
      expect(w.box.seen!.cancelUrl).toMatch(/^https:\/\/site\.example\.com\/manage\.html\?rt=/);
    }
  });

  it('two requests on one booking are two payments, A1 and A2', async () => {
    const w = await world();
    const second = await w.sendRequest(w.b.id, [{ code: 'waiting', label: 'Waiting fee — Colombo Airport → Galle', amountCents: 1500 }]);
    await w.addOnCheckout();
    await w.addOnCheckout(second.id);
    expect((await w.addOnRows()).map((p) => [p.orderId, p.amount]).sort()).toEqual([
      [`${w.b.reference}-A1`, 1000],
      [`${w.b.reference}-A2`, 1500],
    ]);
  });

  it('the trip’s own lane is unchanged: a paid booking with a payable add-on is still not chargeable', async () => {
    const w = await world();
    expect(await refusal(w.checkout({ returnTo: 'manage' }))).toEqual([409, 'not_chargeable']);
    expect(await refusal(w.checkout({ purpose: 'balance' }))).toEqual([409, 'no_balance_due']);
  });

  it('does not re-hold a promo code (it was honoured when the trip was booked)', async () => {
    const promoCodes = new InMemoryPromoCodeRepo();
    const bookings = new InMemoryBookingRepo();
    const payments = new InMemoryPaymentRepo();
    const addOns = new InMemoryAddOnRepo(bookings, payments);
    const start = new Date(Math.floor(Date.now() / 1000) * 1000);
    const clock = { now: start };
    const app = createApp({ bookings, payments, addOns, promoCodes, promoCodesEnabled: true, promoNow: () => clock.now });
    const code = await promoCodes.create({
      code: 'SAVE10', method: 'percentage', value: 1000, startsAt: null,
      expiresAt: new Date(start.getTime() + 3_600_000), maxUses: 5, createdBy: 'f@x.com',
    }, start);
    const created = await bookings.create(single(), { promo: { code, now: start } });
    expect(created.promoCodeId).toBe(code.id);
    const trip = await payments.create({ bookingId: created.id, provider: 'fake', orderId: created.reference, amount: TOTAL, currency: 'USD', idempotencyKey: `checkout:${created.id}` });
    await bookings.setStatus(created.id, 'payment_pending');
    await payments.markSucceeded(trip.id);
    await bookings.setStatus(created.id, 'paid');
    const [leg] = await addOns.listLegs(created.id);
    const request = await addOns.createRequest({
      bookingId: created.id, lines: [{ legId: leg.id, code: 'waiting', label: 'Waiting fee — Colombo Airport → Galle', amountCents: 1000 }],
      currency: 'USD', rateCardVersion: 'card-v1', createdBy: 'ops@ceylonhop.com', now: start, fullyRefundedPaymentIds: [],
    });
    // Days later the code has expired. A re-hold would refuse (promo_code_expired).
    clock.now = new Date(start.getTime() + 3 * 3_600_000);
    const res = await app.request(`/bookings/${created.id}/checkout`, {
      method: 'POST',
      headers: { authorization: `Bearer ${signCheckoutToken(created.id, SECRET, Date.now())}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'add_on', addOnRequestId: request.id }),
    });
    expect(res.status).toBe(200);
  });
});

describe('POST /bookings/view/checkout-token with addOnRequestId', () => {
  it('issues the 30-minute checkout token for a payable request on a paid booking', async () => {
    const w = await world();
    const res = await w.checkoutToken({ addOnRequestId: w.request.id });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.bookingId).toBe(w.b.id);
    expect(verifyCheckoutToken(body.checkoutToken, w.b.id, SECRET, Date.now())).toBe(true);
    expect(verifyCheckoutToken(body.checkoutToken, w.b.id, SECRET, Date.now() + 31 * 60_000)).toBe(false);
  });

  it('the token it issues starts the add-on checkout', async () => {
    const w = await world();
    const { checkoutToken } = await (await w.checkoutToken({ addOnRequestId: w.request.id })).json();
    const res = await w.app.request(`/bookings/${w.b.id}/checkout`, {
      method: 'POST', headers: { authorization: `Bearer ${checkoutToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ purpose: 'add_on', addOnRequestId: w.request.id, returnTo: 'manage' }),
    });
    expect(res.status).toBe(200);
  });

  it('409 add_on_not_payable for a cancelled request, an expired one, and a cancelled booking', async () => {
    const cancelled = await world();
    await cancelled.addOns.cancel(cancelled.request.id, { by: 'ops@ceylonhop.com', reason: 'x', now: new Date(), inFlightAfter: new Date(0) });
    expect(await refusal(cancelled.checkoutToken({ addOnRequestId: cancelled.request.id }))).toEqual([409, 'add_on_not_payable']);
    const expired = await world({ date: inDays(-2) });
    expect(await refusal(expired.checkoutToken({ addOnRequestId: expired.request.id }))).toEqual([409, 'add_on_not_payable']);
    const gone = await world({ status: 'cancelled' });
    expect(await refusal(gone.checkoutToken({ addOnRequestId: gone.request.id }))).toEqual([409, 'add_on_not_payable']);
  });

  it('409 already_paid for a paid request', async () => {
    const w = await world();
    w.addOns.markPaidForSettlement(w.request.id, new Date());
    expect(await refusal(w.checkoutToken({ addOnRequestId: w.request.id }))).toEqual([409, 'already_paid']);
  });

  it('404 for a request of another booking, an unknown one and a malformed id', async () => {
    const w = await world();
    const other = await w.paidBooking();
    const theirs = await w.sendRequest(other.id);
    expect(await refusal(w.checkoutToken({ addOnRequestId: theirs.id }))).toEqual([404, 'not_found']);
    expect(await refusal(w.checkoutToken({ addOnRequestId: randomUUID() }))).toEqual([404, 'not_found']);
    expect(await refusal(w.checkoutToken({ addOnRequestId: 'nope' }))).toEqual([404, 'not_found']);
  });

  it('needs the manage link token', async () => {
    const w = await world();
    const res = await w.app.request('/bookings/view/checkout-token', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ addOnRequestId: w.request.id }),
    });
    expect(res.status).toBe(401);
  });

  it('without addOnRequestId it behaves as before: a paid booking is not chargeable, with or without a body', async () => {
    const w = await world();
    for (const body of [undefined, {}, { something: 'else' }]) {
      const res = await w.checkoutToken(body);
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({ error: 'not_chargeable', status: 'paid' });
    }
  });

  it('without addOnRequestId an unpaid booking still gets its token', async () => {
    const w = await world();
    const unpaid = await w.bookings.create(single());
    await w.bookings.setStatus(unpaid.id, 'payment_pending');
    const res = await w.checkoutToken(undefined, unpaid.id);
    expect(res.status).toBe(200);
    expect((await res.json()).bookingId).toBe(unpaid.id);
  });
});

// The return page polls GET /bookings/pay-return. On a booking that is already paid, "any payment
// succeeded" would tell a customer coming back from an add-on's PayHere page "paid" before the
// add-on's webhook has landed, or after it declined. An add-on return is judged on its own row.
describe('GET /bookings/pay-return for an add-on', () => {
  const status = async (res: Response | Promise<Response>) => (await (await res).json()).status;

  it('pending while the add-on’s webhook has not landed, though the trip is paid', async () => {
    const w = await world();
    const { payReturnToken } = await (await w.addOnCheckout()).json();
    const res = await w.payReturn(payReturnToken);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: 'pending', reference: w.b.reference, sandbox: true, addOnRequestId: w.request.id });
  });

  it('pending before any checkout was started for that request', async () => {
    const w = await world();
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'return', 1)))).toBe('pending');
  });

  it('paid once the add-on’s own payment has succeeded', async () => {
    const w = await world();
    const { payReturnToken } = await (await w.addOnCheckout()).json();
    const [row] = await w.addOnRows();
    await w.payments.markSucceeded(row.id);
    expect(await (await w.payReturn(payReturnToken)).json()).toEqual({
      status: 'paid', reference: w.b.reference, sandbox: true, addOnRequestId: w.request.id,
    });
  });

  it('failed on the cancel leg after a decline; still pending on the return leg', async () => {
    const w = await world();
    await w.addOnCheckout();
    const [row] = await w.addOnRows();
    await w.payments.markFailed(row.id);
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'cancel', 1)))).toBe('failed');
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'return', 1)))).toBe('pending');
  });

  it('one request’s return is not answered by another request’s payment', async () => {
    const w = await world();
    const second = await w.sendRequest(w.b.id, [{ code: 'waiting', label: 'Waiting fee — Colombo Airport → Galle', amountCents: 1500 }]);
    await w.addOnCheckout();
    await w.addOnCheckout(second.id);
    const first = (await w.addOnRows()).find((p) => p.orderId.endsWith('-A1'))!;
    await w.payments.markSucceeded(first.id);
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'return', 1)))).toBe('paid');
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'return', 2)))).toBe('pending');
  });

  it('404 for a request number this booking does not have', async () => {
    const w = await world();
    expect((await w.payReturn(signPayReturnToken(w.b.id, SECRET, 'return', 7))).status).toBe(404);
  });

  it('a trip return is judged on the trip’s rows only: a paid add-on does not make an unpaid trip read paid', async () => {
    const w = await world();
    const unpaid = await w.bookings.create(single());
    await w.bookings.setStatus(unpaid.id, 'payment_pending');
    await w.payments.create({ bookingId: unpaid.id, provider: 'fake', orderId: unpaid.reference, amount: TOTAL, currency: 'USD', idempotencyKey: `checkout:${unpaid.id}` });
    const addOn = await w.payments.create({
      bookingId: unpaid.id, provider: 'fake', orderId: `${unpaid.reference}-A1`, amount: 1000, currency: 'USD',
      idempotencyKey: `checkout:${unpaid.id}:addon:r1`, purpose: 'add_on',
    });
    await w.payments.markSucceeded(addOn.id);
    const res = await w.payReturn(signPayReturnToken(unpaid.id, SECRET));
    expect(await res.json()).toEqual({ status: 'pending', reference: unpaid.reference, sandbox: true });
  });

  it('a trip return on a paid booking with a declined add-on is still paid, on either leg', async () => {
    const w = await world();
    await w.addOnCheckout();
    const [row] = await w.addOnRows();
    await w.payments.markFailed(row.id);
    expect(await (await w.payReturn(signPayReturnToken(w.b.id, SECRET))).json()).toEqual({ status: 'paid', reference: w.b.reference, sandbox: true });
    expect(await status(w.payReturn(signPayReturnToken(w.b.id, SECRET, 'cancel')))).toBe('paid');
  });
});
