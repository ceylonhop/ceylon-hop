import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { seatPriceForDistance } from '../quote/seatPrice';
import type { JwtVerifier } from '../lib/googleAuth';
import { PayHereTokenizedPaymentAdapter } from '../adapters/payhereTokenized';
import { FakeAlertAdapter } from '../adapters/alerts';
import { futureIsoDate } from '../testSupport/dates';

// Joining is only allowed while the cutoff is still ahead (a seat nothing can charge for is a
// free rider — see the guard in routes/rideBoard.ts), so these dates must be anchored to now.
// A hardcoded calendar date here rots into the past and turns the whole suite red at a
// midnight rollover, on a commit that never changed.
const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: futureIsoDate(30), slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: null, cutoffAt: new Date(Date.now() + 2 * 86_400_000),
  createdBy: null, ...over,
});

function makeApp(identity: Partial<{ sub: string; email: string; name: string; picture: string }> = {}) {
  const id = { sub: 'roshen-sub', email: 'roshen@x.com', name: 'Roshen W', picture: 'https://p/r', ...identity };
  const rideLists = new InMemoryRideListRepo();
  const paygw = new FakeTokenizedPaymentAdapter();
  const verifier: JwtVerifier = async () => ({
    payload: { iss: 'accounts.google.com', email: id.email, email_verified: true, name: id.name, sub: id.sub, picture: id.picture },
  });
  const app = createApp({ rideLists, paygw, customerVerifier: verifier });
  return { app, rideLists, paygw };
}

async function loginCookie(app: ReturnType<typeof makeApp>['app'], country = 'LK'): Promise<string> {
  const res = await app.request('/board/login', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ credential: 'tok', country }),
  });
  expect(res.status).toBe(200);
  const setCookie = res.headers.get('set-cookie') ?? '';
  return (setCookie.match(/ch_cust=[^;]+/) ?? [''])[0];
}

const json = (cookie?: string, body?: unknown) => ({
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(cookie ? { cookie } : {}) },
  ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
});

const paymentDetails = {
  phone: '+94771234567',
  address: '12 Galle Road',
  city: 'Colombo',
};

function makePayHereApp(over: { rateLimit?: { max: number; windowMs: number }; alerts?: FakeAlertAdapter } = {}) {
  const rideLists = new InMemoryRideListRepo();
  const paygw = new PayHereTokenizedPaymentAdapter(
    '1234567',
    'merchant-secret',
    { mode: 'sandbox', notifyUrl: 'https://ops.ceylonhop.com/board/payhere/notify' },
    { appId: 'app-id', appSecret: 'app-secret' },
  );
  const verifier: JwtVerifier = async () => ({
    payload: {
      iss: 'accounts.google.com', email: 'roshen@x.com', email_verified: true,
      name: 'Roshen Wijesinghe', sub: 'roshen-sub', picture: 'https://p/r',
    },
  });
  const app = createApp({
    rideLists,
    paygw,
    customerVerifier: verifier,
    bookingBaseUrl: 'https://ceylonhop.com',
    ...(over.rateLimit ? { rateLimit: over.rateLimit } : {}),
    ...(over.alerts ? { alerts: over.alerts } : {}),
  });
  return { app, rideLists, paygw };
}

describe('POST /board/login', () => {
  it('signs in and returns a public "me"', async () => {
    const { app } = makeApp();
    const res = await app.request('/board/login', json(undefined, { credential: 'tok', country: 'FR' }));
    const body = await res.json();
    expect(body.ok).toBe(true);
    expect(body.me).toEqual({ firstName: 'Roshen', country: 'FR', photo: 'https://p/r' });
    expect(res.headers.get('set-cookie')).toMatch(/ch_cust=/);
  });
  it('rejects a missing credential', async () => {
    const { app } = makeApp();
    expect((await app.request('/board/login', json(undefined, {}))).status).toBe(400);
  });
});

describe('POST /board/:code/join', () => {
  it('requires a signed-in traveller', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    expect((await app.request(`/board/${l.code}/join`, json(undefined, {}))).status).toBe(401);
  });

  it('adds the traveller, preapproves the card, and reflects the count', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const res = await app.request(`/board/${l.code}/join`, json(cookie, { preferredTime: '09:00', seats: 1 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list.committed).toBe(1);
    expect(body.list.members[0].firstName).toBe('Roshen');
    expect(body.manageToken).toBeTruthy();
    expect(paygw.preapprovals).toHaveLength(1); // card held once
  });

  it('is idempotent — a second join adds no member and no extra preapproval', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, {}));
    const res = await app.request(`/board/${l.code}/join`, json(cookie, {}));
    expect(res.status).toBe(200);
    expect((await res.json()).list.committed).toBe(1);
    expect(paygw.preapprovals).toHaveLength(1);
  });

  it('409s when the van is full', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs({ capacity: 2 }));
    await rideLists.addMember(l.id, { sub: 'a', firstName: 'A', country: 'US', email: 'a@x.com', seats: 1 });
    await rideLists.addMember(l.id, { sub: 'b', firstName: 'B', country: 'GB', email: 'b@x.com', seats: 1 });
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, json(cookie, {}))).status).toBe(409);
  });

  it('409s a closed (expired) list', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    await rideLists.setStatus(l.id, 'expired');
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, json(cookie, {}))).status).toBe(409);
  });
});

// The cutoff sweep is the ONLY thing in this codebase that calls paygw.charge(), and it
// selects `status = 'gathering'` lists whose cutoff has passed. So a traveller admitted to a
// list the sweep will not (or no longer will) look at preapproves their card, takes a seat on
// the manifest, and is never billed — a free rider with no failure anywhere to alert on.
//
// Two doors led to that state, and closing only the obvious one leaves the bug reachable:
//   1. the list is already 'confirmed' — the sweep never revisits a confirmed list;
//   2. the list is still 'gathering' but the sweep is mid-flight — lockDeparture() sets only
//      locked_time, so the list stays 'gathering' across the whole charge loop (N PayHere
//      round trips), and the members it will charge were snapshotted before that loop began.
// Guarding on the cutoff INSTANT closes both with one condition, and needs no new status.
describe('POST /board/:code/join — never admit a traveller the sweep will not charge', () => {
  it('409s a confirmed list (the sweep never revisits one, so a joiner rides free)', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    await rideLists.setStatus(l.id, 'confirmed');
    const cookie = await loginCookie(app);

    const res = await app.request(`/board/${l.code}/join`, json(cookie, {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('closed');
    // Nothing was taken from them either: no seat, and no card approval to strand.
    expect(paygw.preapprovals).toHaveLength(0);
    expect((await rideLists.getByCode(l.code))?.members).toHaveLength(0);
  });

  it('409s a gathering list whose cutoff has passed — the sweep already has its member list', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs({ cutoffAt: new Date(Date.now() - 60_000) }));
    expect(l.status).toBe('gathering'); // exactly the state the sweep leaves it in while charging
    const cookie = await loginCookie(app);

    const res = await app.request(`/board/${l.code}/join`, json(cookie, {}));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('closed');
    expect(paygw.preapprovals).toHaveLength(0);
  });
});

describe('Ride Board PayHere card approval', () => {
  it('does not add the traveller until a signed PayHere callback approves the card', async () => {
    const { app, rideLists, paygw } = makePayHereApp();
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);

    const started = await app.request(`/board/${list.code}/join`, json(cookie, {
      seats: 1,
      preferredTime: '09:00',
      payment: paymentDetails,
    }));
    expect(started.status).toBe(202);
    const startBody = await started.json();
    expect(startBody.status).toBe('payment_required');
    expect(startBody.payment.checkoutUrl).toBe('https://sandbox.payhere.lk/pay/preapprove');
    expect((await rideLists.getByCode(list.code))?.members.filter((m) => m.status === 'held')).toHaveLength(0);

    const pending = await app.request(`/board/payments/${startBody.payment.orderId}`, { headers: { cookie } });
    expect(await pending.json()).toEqual({ status: 'pending' });

    const notify = paygw.simulatePreapprovalNotify({
      orderId: startBody.payment.orderId,
      customerToken: 'real-encrypted-card-token',
    });
    expect((await app.request('/board/payhere/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: notify,
    })).status).toBe(200);

    const completed = await app.request(`/board/payments/${startBody.payment.orderId}`, { headers: { cookie } });
    const completedBody = await completed.json();
    expect(completedBody.status).toBe('succeeded');
    expect(completedBody.list.committed).toBe(1);
    expect(completedBody.manageToken).toBeTruthy();
    expect((await rideLists.getByCode(list.code))?.members[0].preapprovalRef).toBe('real-encrypted-card-token');
  });

  // PayHere's preapproval callback is the ONLY delivery of the reusable customer token. Every
  // notify arrives from a handful of PayHere egress IPs, so they all share one per-IP bucket:
  // a busy signup hour 429s a genuine callback, the token is lost for good, and the traveller's
  // preapproval expires as "failed" 30 minutes later even though they completed it. The main
  // /webhooks/payments mount is already exempt for exactly this reason (app.ts) — this gateway
  // callback was not.
  it('never rate-limits the PayHere preapproval callback', async () => {
    const { app, rideLists, paygw } = makePayHereApp({ rateLimit: { max: 1, windowMs: 60_000 } });
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);
    const started = await app.request(`/board/${list.code}/join`, json(cookie, { payment: paymentDetails }));
    const body = await started.json();
    const notify = paygw.simulatePreapprovalNotify({
      orderId: body.payment.orderId,
      customerToken: 'real-encrypted-card-token',
    });
    const post = () =>
      app.request('/board/payhere/notify', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: notify,
      });

    // The budget is already spent by the join above; PayHere's callback must still get through.
    for (let i = 0; i < 5; i++) {
      expect((await post()).status).not.toBe(429);
    }
    expect((await rideLists.getByCode(list.code))?.members[0].preapprovalRef).toBe('real-encrypted-card-token');
  });

  // A wrong per-domain merchant secret is exactly the PH-0014 class of failure this flow already
  // hit once. It fails as a silent 400: every traveller's join dies and nothing tells anyone.
  // /webhooks/payments pages the founder on a rejected notify; this one must too.
  it('alerts when a PayHere callback cannot be verified', async () => {
    const alerts = new FakeAlertAdapter();
    const { app, rideLists, paygw } = makePayHereApp({ alerts });
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);
    const started = await app.request(`/board/${list.code}/join`, json(cookie, { payment: paymentDetails }));
    const body = await started.json();
    const genuine = paygw.simulatePreapprovalNotify({ orderId: body.payment.orderId, customerToken: 'token' });
    const forged = genuine.replace(/md5sig=[^&]+/, 'md5sig=00000000000000000000000000000000');

    expect((await app.request('/board/payhere/notify', { method: 'POST', body: forged })).status).toBe(400);

    const alert = alerts.sent.find((a) => a.kind === 'ride_board_notify_rejected');
    expect(alert, 'a rejected board callback must page a human').toBeTruthy();
    expect(alert?.severity).toBe('critical');
  });

  it('ignores a forged callback and keeps the traveller off the ride', async () => {
    const { app, rideLists, paygw } = makePayHereApp();
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);
    const started = await app.request(`/board/${list.code}/join`, json(cookie, { payment: paymentDetails }));
    const body = await started.json();
    const genuine = paygw.simulatePreapprovalNotify({ orderId: body.payment.orderId, customerToken: 'token' });
    const forged = genuine.replace(/md5sig=[^&]+/, 'md5sig=00000000000000000000000000000000');

    expect((await app.request('/board/payhere/notify', { method: 'POST', body: forged })).status).toBe(400);
    expect((await rideLists.getByCode(list.code))?.members.filter((m) => m.status === 'held')).toHaveLength(0);
  });

  it('releases a pending seat when the traveller cancels PayHere', async () => {
    const { app, rideLists } = makePayHereApp();
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);
    const started = await app.request(`/board/${list.code}/join`, json(cookie, { payment: paymentDetails }));
    const body = await started.json();

    const cancelled = await app.request(`/board/payments/${body.payment.orderId}/cancel`, json(cookie));
    expect(cancelled.status).toBe(200);
    expect((await rideLists.getByCode(list.code))?.members[0].status).toBe('preapproval_failed');
    expect(await (await app.request(`/board/payments/${body.payment.orderId}`, { headers: { cookie } })).json())
      .toEqual({ status: 'failed' });
  });

  it('keeps a newly-created list private until its creator approves a card', async () => {
    const { app, paygw } = makePayHereApp();
    const cookie = await loginCookie(app);
    const started = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning',
      payment: paymentDetails,
    }));
    expect(started.status).toBe(202);
    const body = await started.json();
    expect((await (await app.request('/board')).json()).lists).toHaveLength(0);

    const notify = paygw.simulatePreapprovalNotify({ orderId: body.payment.orderId, customerToken: 'token' });
    await app.request('/board/payhere/notify', { method: 'POST', body: notify });
    const board = await (await app.request('/board')).json();
    expect(board.lists).toHaveLength(1);
    expect(board.lists[0].committed).toBe(1);
  });
});

// One traveller can bring people with them — up to three seats on the one name. The seats
// are what the van counts, so a pair of friends move the list twice as far as a solo name.
describe('POST /board/:code/join — more than one seat', () => {
  it('takes three seats on one name and counts every one of them', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 3 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list.committed).toBe(3);
    expect(body.list.members).toHaveLength(1); // one name, three seats
    expect(body.list.members[0].seats).toBe(3);
  });

  it('refuses a fourth seat — three is the most one traveller may take', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, json(cookie, { seats: 4 }))).status).toBe(400);
  });

  // Changing your seat count is a scratch-and-re-add underneath, but the traveller should
  // neither lose their place in the line nor have their card held a second time.
  it('changes a seat count in place, keeping the position and the single card hold', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    await rideLists.addMember(l.id, { sub: 'a', firstName: 'Ada', country: 'US', email: 'a@x.com', seats: 1 });
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.list.committed).toBe(3); // Ada's 1 + my 2
    expect(body.list.members).toHaveLength(2);
    const me = body.list.members.find((m: { firstName: string }) => m.firstName === 'Roshen');
    expect(me.seats).toBe(2);
    expect(me.position).toBe(2); // still second in line, not sent to the back
    expect(paygw.preapprovals).toHaveLength(1); // card held once, not twice
  });

  // The naive check (live seats + requested) double-counts the seats you already hold and
  // would refuse a 1→2 change on a van that plainly has room for it.
  it('counts a seat change net of the seats you already hold', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs({ capacity: 6 }));
    await rideLists.addMember(l.id, { sub: 'a', firstName: 'Ada', country: 'US', email: 'a@x.com', seats: 3 });
    await rideLists.addMember(l.id, { sub: 'b', firstName: 'Bo', country: 'GB', email: 'b@x.com', seats: 1 });
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 })); // van now 5 of 6
    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }));
    expect(res.status).toBe(200);
    expect((await res.json()).list.committed).toBe(6);
    // ...and one seat past the van is still a full van
    expect((await app.request(`/board/${l.code}/join`, json(cookie, { seats: 3 }))).status).toBe(409);
  });

  it('leaves your seats and your preferred time alone when a later join omits them', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2, preferredTime: '09:00' }));
    const res = await app.request(`/board/${l.code}/join`, json(cookie, {}));
    expect(res.status).toBe(200);
    expect((await res.json()).list.committed).toBe(2); // not silently reset to one seat
    const fresh = await rideLists.getByCode(l.code);
    expect(fresh!.members[0].preferredTime).toBe('09:00'); // their vote survives
  });

  it('tells you which member is you, so the page can offer to change your seats', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    await rideLists.addMember(l.id, { sub: 'a', firstName: 'Ada', country: 'US', email: 'a@x.com', seats: 1 });
    const cookie = await loginCookie(app);
    const body = await (await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }))).json();
    const mine = body.list.members.filter((m: { isYou: boolean }) => m.isYou);
    expect(mine).toHaveLength(1);
    expect(mine[0].firstName).toBe('Roshen');
  });
});

describe('POST /board/:code/scratch', () => {
  it('removes your name when signed in', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, {}));
    const res = await app.request(`/board/${l.code}/scratch`, json(cookie));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.removed).toBe(true);
    expect(body.list.committed).toBe(0);
  });

  it('works via a manage token without a cookie', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const joined = await (await app.request(`/board/${l.code}/join`, json(cookie, {}))).json();
    const res = await app.request(`/board/${l.code}/scratch?t=${encodeURIComponent(joined.manageToken)}`, { method: 'POST' });
    expect(res.status).toBe(200);
    expect((await res.json()).removed).toBe(true);
  });
});

// A pooled van and a scheduled seat on the SAME leg must cost the same, or the search page
// shows two prices for one journey. On a catalogue leg the board takes the catalogue price;
// everywhere else it still prices off the road distance.
describe('POST /board (create) — catalogue legs', () => {
  const noMaps = {
    provider: 'outage', places: async () => [], distanceVariants: async () => null,
    distance: async () => { throw new Error('distance must not be called on a catalogue leg'); },
  };

  function catalogueApp() {
    const rideLists = new InMemoryRideListRepo();
    const verifier: JwtVerifier = async () => ({
      payload: { iss: 'accounts.google.com', email: 'r@x.com', email_verified: true, name: 'Roshen W', sub: 's', picture: 'p' },
    });
    return createApp({
      rideLists, paygw: new FakeTokenizedPaymentAdapter(), customerVerifier: verifier,
      maps: noMaps as never,
    });
  }

  it('prices a catalogue leg from the catalogue, without asking Google', async () => {
    const app = catalogueApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Negombo', to: 'Sigiriya / Dambulla', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    // $27.49 — the scheduled seat price, not seatPriceForDistance(148) = $26.50.
    expect((await res.json()).list.seatPrice).toBe(2749);
  });

  it('gives a second catalogue leg on the same corridor its own price', async () => {
    const app = catalogueApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Sigiriya / Dambulla', to: 'Kandy', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).list.seatPrice).toBe(1999);
  });

  it('still prices an off-catalogue leg off the road distance', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).list.seatPrice).toBe(seatPriceForDistance(164)); // fake maps km
  });

  it('does not price the REVERSE of a catalogue leg from the catalogue', async () => {
    // Sigiriya -> Negombo is not sold; pooling it is fine, but at the distance price.
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Sigiriya / Dambulla', to: 'Negombo', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).list.seatPrice).not.toBe(2749);
  });
});

describe('POST /board (create) — pricing', () => {
  // A crow-flies estimate runs tens of percent out, so it must never become a seat price. When
  // Google can't answer we decline the list rather than charge against a guess.
  const outage = { provider: 'outage', places: async () => [], distanceVariants: async () => null };

  it('declines to create a list when the road distance is unavailable', async () => {
    const rideLists = new InMemoryRideListRepo();
    const verifier: JwtVerifier = async () => ({
      payload: { iss: 'accounts.google.com', email: 'r@x.com', email_verified: true, name: 'Roshen W', sub: 's', picture: 'p' },
    });
    const app = createApp({
      rideLists, paygw: new FakeTokenizedPaymentAdapter(), customerVerifier: verifier,
      maps: { ...outage, distance: async () => null } as never,
    });
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning' }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('cannot_price_route');
  });

  it('declines when the distance is only an offline estimate', async () => {
    const rideLists = new InMemoryRideListRepo();
    const verifier: JwtVerifier = async () => ({
      payload: { iss: 'accounts.google.com', email: 'r@x.com', email_verified: true, name: 'Roshen W', sub: 's', picture: 'p' },
    });
    const app = createApp({
      rideLists, paygw: new FakeTokenizedPaymentAdapter(), customerVerifier: verifier,
      maps: { ...outage, distance: async () => ({ km: 164, durationMin: 240, estimated: true }) } as never,
    });
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning' }));
    expect(res.status).toBe(503);
  });
});

describe('POST /board (create)', () => {
  it('creates a list and auto-joins the creator as name #1', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning', note: 'surfers' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.list.from).toBe('Ella');
    expect(body.list.to).toBe('Mirissa');
    // Priced off the road distance via the engine (van fare / 3, to the nearest 50c) rather than
    // the corridor's old hand-set rate — Ella → Mirissa is 164 km, so $88.64 van → $29.50 a seat.
    expect(body.list.seatPrice).toBe(seatPriceForDistance(164));
    expect(body.list.seatPrice).toBe(2950);
    expect(body.list.members[0].firstName).toBe('Roshen');
    expect(body.list.committed).toBe(1);
  });

  it('rejects a past date and an unknown corridor', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    expect((await app.request('/board', json(cookie, { from: 'Ella', to: 'Mirissa', date: '2000-01-01', slot: 'morning' }))).status).toBe(400);
    expect((await app.request('/board', json(cookie, { from: 'Nowhere', to: 'Void', date: '2999-08-08', slot: 'morning' }))).status).toBe(400);
  });
});

describe('GET /board/mine & /board/dupe', () => {
  it('lists the rides I am on', async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, {}));
    const res = await app.request('/board/mine', { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).lists).toHaveLength(1);
  });

  it('surfaces an existing list for the dedupe nudge', async () => {
    const { app, rideLists } = makeApp();
    await rideLists.createList(listArgs());
    const res = await app.request('/board/dupe?from=Ella&to=Mirissa');
    expect((await res.json()).list.from).toBe('Ella');
    const none = await app.request('/board/dupe?from=Kandy&to=Ella');
    expect((await none.json()).list).toBeNull();
  });
});

// The ch_cust cookie is SameSite=None so it rides cross-site requests. /scratch reads no body,
// so a bodyless cross-site POST is a "simple request" with no CORS preflight — it used to remove
// a signed-in traveller from their list. Demonstrated before the fix; pinned here.
describe('ride board CSRF', () => {
  const listOn = async () => {
    const { app, rideLists } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { preferredTime: '09:00', seats: 1 }));
    return { app, code: l.code, cookie };
  };
  const names = async (app: ReturnType<typeof makeApp>['app'], code: string) => {
    const body = await (await app.request(`/board/${code}`)).json();
    return (body.members ?? []).map((m: { firstName?: string }) => m.firstName);
  };

  it('refuses a cross-site scratch and leaves the traveller on the list', async () => {
    const { app, code, cookie } = await listOn();
    expect(await names(app, code)).toHaveLength(1);
    const res = await app.request(`/board/${code}/scratch`, {
      method: 'POST',
      headers: { cookie, origin: 'https://evil.example' },
    });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
    expect(await names(app, code)).toHaveLength(1); // still there
  });

  it('still lets our own site scratch', async () => {
    const { app, code, cookie } = await listOn();
    const res = await app.request(`/board/${code}/scratch`, {
      method: 'POST',
      headers: { cookie, origin: 'http://localhost:4173' },
    });
    expect(res.status).toBe(200);
    expect(await names(app, code)).toHaveLength(0);
  });
});
