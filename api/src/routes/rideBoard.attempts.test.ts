import { describe, it, expect, vi, afterEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { InMemoryRideBoardEventRepo, type RideBoardEventRepo } from '../db/rideBoardEventRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { PayHereTokenizedPaymentAdapter } from '../adapters/payhereTokenized';
import type { JwtVerifier } from '../lib/googleAuth';
import { futureIsoDate } from '../testSupport/dates';
import { isoToday } from '../domain/dateRules';

// Every attempt to start or join a ride leaves a row — including the ones that fail. Before
// this, a refused join (EA-8707: "that list just closed") left no trace anywhere: not in the
// database, not in the logs, not in GA4. Nobody could count how many travellers the board
// turned away, or why.

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: futureIsoDate(30), slot: 'morning',
  minSeats: 3, capacity: 6, seatPrice: 2400, note: null, cutoffAt: new Date(Date.now() + 2 * 86_400_000),
  createdBy: null, ...over,
});

const verifier: JwtVerifier = async () => ({
  payload: {
    iss: 'accounts.google.com', email: 'roshen@x.com', email_verified: true,
    name: 'Roshen W', sub: 'roshen-sub', picture: 'https://p/r',
  },
});

function fakeApp(repo?: RideBoardEventRepo) {
  const rideLists = new InMemoryRideListRepo();
  const paygw = new FakeTokenizedPaymentAdapter();
  const events = new InMemoryRideBoardEventRepo();
  const app = createApp({ rideLists, paygw, customerVerifier: verifier, rideBoardEvents: repo ?? events });
  return { app, rideLists, paygw, events };
}

function payHereApp() {
  const rideLists = new InMemoryRideListRepo();
  const events = new InMemoryRideBoardEventRepo();
  const paygw = new PayHereTokenizedPaymentAdapter(
    '1234567',
    'merchant-secret',
    { mode: 'sandbox', notifyUrl: 'https://ops.ceylonhop.com/board/payhere/notify' },
    { appId: 'app-id', appSecret: 'app-secret' },
  );
  const app = createApp({
    rideLists, paygw, customerVerifier: verifier, rideBoardEvents: events, bookingBaseUrl: 'https://ceylonhop.com',
  });
  return { app, rideLists, paygw, events };
}

async function loginCookie(app: ReturnType<typeof fakeApp>['app'], country = 'DE'): Promise<string> {
  const res = await app.request('/board/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'tok', country }),
  });
  return ((res.headers.get('set-cookie') ?? '').match(/ch_cust=[^;]+/) ?? [''])[0];
}

const post = (cookie?: string, body?: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

const paymentDetails = { phone: '+94771234567', address: '12 Galle Road', city: 'Colombo' };

const notifyReq = (body: string) => ({
  method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body,
});

describe('ride board attempt log — refusals', () => {
  it('records a join refused because the list has closed (the EA-8707 case)', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs({ cutoffAt: new Date(Date.now() - 60_000) }));
    const cookie = await loginCookie(app);
    const res = await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails, seats: 2 }));
    expect(res.status).toBe(409);

    expect(events.all()).toEqual([
      expect.objectContaining({
        action: 'join', outcome: 'refused', reason: 'closed', listCode: l.code,
        customerSub: 'roshen-sub', country: 'DE', httpStatus: 409,
      }),
    ]);
  });

  it('records a join refused because nobody is signed in', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs());
    expect((await app.request(`/board/${l.code}/join`, post(undefined, {}))).status).toBe(401);
    expect(events.all()).toEqual([
      expect.objectContaining({ action: 'join', outcome: 'refused', reason: 'sign_in_required', listCode: l.code, customerSub: null }),
    ]);
  });

  it('records a start refused for being too close, with the route and date the traveller wanted', async () => {
    const { app, events } = fakeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', post(cookie, { payment: paymentDetails, from: 'Ella', to: 'Arugam Bay', date: isoToday(), slot: 'morning' }));
    expect(res.status).toBe(400);
    expect(events.all()).toEqual([
      expect.objectContaining({
        action: 'start', outcome: 'refused', reason: 'cutoff_passed',
        fromPlace: 'Ella', toPlace: 'Arugam Bay', rideDate: isoToday(), slot: 'morning', listCode: null,
      }),
    ]);
  });

  it('records an unparseable body as invalid_request', async () => {
    const { app, events } = fakeApp();
    const cookie = await loginCookie(app);
    expect((await app.request('/board', post(cookie, { payment: paymentDetails, from: 'Ella' }))).status).toBe(400);
    expect(events.all()[0]).toMatchObject({ action: 'start', outcome: 'refused', reason: 'invalid_request' });
  });
});

describe('ride board attempt log — successes', () => {
  it('records a join that held a seat inline', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails, seats: 2 }))).status).toBe(200);
    expect(events.all()).toEqual([
      expect.objectContaining({
        action: 'join', outcome: 'succeeded', reason: null, listCode: l.code, corridorId: 'ella-south',
        rideDate: l.date, slot: 'morning', seats: 2, customerSub: 'roshen-sub', httpStatus: 200,
      }),
    ]);
  });

  it('records a started ride with its new list code', async () => {
    const { app, events } = fakeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', post(cookie, { payment: paymentDetails, from: 'Ella', to: 'Mirissa', date: futureIsoDate(40), slot: 'morning' }));
    expect(res.status).toBe(201);
    const code = (await res.json()).list.code;
    expect(events.all()).toEqual([
      expect.objectContaining({ action: 'start', outcome: 'succeeded', listCode: code, fromPlace: 'Ella', toPlace: 'Mirissa' }),
    ]);
  });

  it('records a scratch', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails,}));
    await app.request(`/board/${l.code}/scratch`, post(cookie));
    expect(events.all().map((e) => [e.action, e.outcome])).toEqual([['join', 'succeeded'], ['scratch', 'succeeded']]);
  });
});

describe('ride board attempt log — the PayHere path (production)', () => {
  afterEach(() => vi.useRealTimers());

  it('records the hand-off to PayHere and the approval that completes it', async () => {
    const { app, rideLists, paygw, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const started = await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }));
    expect(started.status).toBe(202);
    const orderId = (await started.json()).payment.orderId;

    const notify = paygw.simulatePreapprovalNotify({ orderId, customerToken: 'tok' });
    expect((await app.request('/board/payhere/notify', notifyReq(notify))).status).toBe(200);

    expect(events.all()).toEqual([
      expect.objectContaining({ action: 'join', outcome: 'payment_started', listCode: l.code, orderId, customerSub: 'roshen-sub' }),
      expect.objectContaining({ action: 'join', outcome: 'succeeded', reason: 'payhere', listCode: l.code, orderId, customerSub: 'roshen-sub' }),
    ]);
  });

  it('records a start completed by PayHere as a start', async () => {
    const { app, paygw, events } = payHereApp();
    const cookie = await loginCookie(app);
    const started = await app.request('/board', post(cookie, {
      from: 'Ella', to: 'Mirissa', date: futureIsoDate(40), slot: 'morning', payment: paymentDetails,
    }));
    const orderId = (await started.json()).payment.orderId;
    await app.request('/board/payhere/notify', notifyReq(paygw.simulatePreapprovalNotify({ orderId, customerToken: 'tok' })));
    expect(events.all().map((e) => [e.action, e.outcome])).toEqual([['start', 'payment_started'], ['start', 'succeeded']]);
  });

  it('records a card PayHere declined', async () => {
    const { app, rideLists, paygw, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    await app.request('/board/payhere/notify', notifyReq(paygw.simulatePreapprovalNotify({ orderId, customerToken: '', statusCode: '-2' })));
    expect(events.all()[1]).toMatchObject({ action: 'join', outcome: 'payment_failed', reason: 'declined', orderId, listCode: l.code });
  });

  it('records a traveller backing out of PayHere', async () => {
    const { app, rideLists, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    await app.request(`/board/payments/${orderId}/cancel`, post(cookie));
    expect(events.all()[1]).toMatchObject({ action: 'join', outcome: 'payment_failed', reason: 'cancelled_by_traveller', orderId });
  });

  it('records a cancellation PayHere reports on its own callback', async () => {
    const { app, rideLists, paygw, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    await app.request('/board/payhere/notify', notifyReq(paygw.simulatePreapprovalNotify({ orderId, customerToken: '', statusCode: '-1' })));
    expect(events.all()[1]).toMatchObject({ outcome: 'payment_failed', reason: 'cancelled_at_payhere', orderId });
  });

  it('records an approval that timed out', async () => {
    const { app, rideLists, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60_000); // past the 30-minute approval window
    await app.request(`/board/payments/${orderId}`, { headers: { cookie } });
    expect(events.all()[1]).toMatchObject({ action: 'join', outcome: 'payment_failed', reason: 'expired', orderId });
  });

  it('records a card approved after the window closed, not as a full van', async () => {
    const { app, rideLists, paygw, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 31 * 60_000);
    await app.request('/board/payhere/notify', notifyReq(paygw.simulatePreapprovalNotify({ orderId, customerToken: 'tok' })));
    expect(events.all()[1]).toMatchObject({ outcome: 'payment_failed', reason: 'approved_too_late', orderId });
  });

  it('logs a retried PayHere callback once', async () => {
    const { app, rideLists, paygw, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const orderId = (await (await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails }))).json()).payment.orderId;
    const notify = paygw.simulatePreapprovalNotify({ orderId, customerToken: 'tok' });
    await app.request('/board/payhere/notify', notifyReq(notify));
    await app.request('/board/payhere/notify', notifyReq(notify));
    expect(events.all().map((e) => e.outcome)).toEqual(['payment_started', 'succeeded']);
  });

  // A join with no details at all is now refused before PayHere is approached (2026-09-23): the
  // phone number is required on every new commitment, so that is the reason logged.
  it('records the missing-details refusal before any card is approached', async () => {
    const { app, rideLists, events } = payHereApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, post(cookie, {}))).status).toBe(400);
    expect(events.all()).toEqual([
      expect.objectContaining({ action: 'join', outcome: 'refused', reason: 'phone_required' }),
    ]);
  });
});

describe('ride board attempt log — never gets in the way', () => {
  it('still joins the traveller when the log itself fails', async () => {
    const broken: RideBoardEventRepo = {
      record: () => Promise.reject(new Error('db down')),
      since: async () => [],
    };
    const { app, rideLists } = fakeApp(broken);
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails,}))).status).toBe(200);
  });

  it('records a server error as an error, not a refusal', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs());
    rideLists.getByCode = () => Promise.reject(new Error('boom'));
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, post(cookie, { payment: paymentDetails,}))).status).toBe(500);
    expect(events.all()).toEqual([
      expect.objectContaining({ action: 'join', outcome: 'error', reason: 'server_error', httpStatus: 500 }),
    ]);
  });

  it('logs nothing for reads', async () => {
    const { app, rideLists, events } = fakeApp();
    const l = await rideLists.createList(listArgs());
    await app.request('/board');
    await app.request(`/board/${l.code}`);
    expect(events.all()).toEqual([]);
  });
});
