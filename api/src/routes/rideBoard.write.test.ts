import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import { seatPriceForDistance } from '../quote/seatPrice';
import type { JwtVerifier } from '../lib/googleAuth';
import { PayHereTokenizedPaymentAdapter } from '../adapters/payhereTokenized';
import { FakeAlertAdapter } from '../adapters/alerts';
import { FakeEmailAdapter, type EmailAdapter } from '../adapters/email';
import { futureIsoDate, nextIsoWeekday } from '../testSupport/dates';
import { isoToday } from '../domain/dateRules';

// Joining is only allowed while the cutoff is still ahead (a seat nothing can charge for is a
// free rider — see the guard in routes/rideBoard.ts), so these dates must be anchored to now.
// A hardcoded calendar date here rots into the past and turns the whole suite red at a
// midnight rollover, on a commit that never changed.
const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: futureIsoDate(30), slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: null, cutoffAt: new Date(Date.now() + 2 * 86_400_000),
  createdBy: null, ...over,
});

function makeApp(identity: Partial<{ sub: string; email: string; name: string; picture: string }> = {}, over: { bookingBaseUrl?: string; email?: EmailAdapter; digestTo?: string; opsBaseUrl?: string } = {}) {
  const id = { sub: 'roshen-sub', email: 'roshen@x.com', name: 'Roshen W', picture: 'https://p/r', ...identity };
  const rideLists = new InMemoryRideListRepo();
  const paygw = new FakeTokenizedPaymentAdapter();
  const email = over.email ?? new FakeEmailAdapter();
  const verifier: JwtVerifier = async () => ({
    payload: { iss: 'accounts.google.com', email: id.email, email_verified: true, name: id.name, sub: id.sub, picture: id.picture },
  });
  const app = createApp({ rideLists, paygw, customerVerifier: verifier, ...over, email });
  return { app, rideLists, paygw, email };
}

// The joiner's receipt is asserted against a known origin so the link in it can be
// checked byte-for-byte; makeApp otherwise leaves the base URL to config.
const mailApp = (identity: Parameters<typeof makeApp>[0] = {}, email?: EmailAdapter) =>
  makeApp(identity, { bookingBaseUrl: 'https://ceylonhop.com', email });

// Same, with an ops inbox configured — the internal "seat held" mail only fires when one is
// (ALERT_EMAIL in production, unset in tests unless a case asks for it).
const opsMailApp = (identity: Parameters<typeof makeApp>[0] = {}, email?: EmailAdapter) =>
  makeApp(identity, { bookingBaseUrl: 'https://ceylonhop.com', email, digestTo: 'ops@x.com', opsBaseUrl: 'https://ops.example' });

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

function makePayHereApp(over: { rateLimit?: { max: number; windowMs: number }; alerts?: FakeAlertAdapter; email?: EmailAdapter; digestTo?: string; opsBaseUrl?: string } = {}) {
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
    ...(over.email ? { email: over.email } : {}),
    ...(over.digestTo ? { digestTo: over.digestTo } : {}),
    ...(over.opsBaseUrl ? { opsBaseUrl: over.opsBaseUrl } : {}),
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
// ============================================================================
// Joining is the moment a traveller commits a card to a ride that may never run
// — and until this it sent them nothing at all. No record of what was pledged,
// no charge amount, no deadline, and (once the tab closed) no way back to the
// page that can take their name off. These pin the receipt.
// ============================================================================
describe('POST /board/:code/join — the traveller gets a receipt', () => {
  it('emails the joiner their ride, with the code and a link back to it', async () => {
    const { app, rideLists, email } = mailApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    expect(res.status).toBe(200);

    const sent = (email as FakeEmailAdapter).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe('roshen@x.com');
    expect(sent[0].html).toContain(l.code);
    // The way out. Without a link the email is a dead end — which is half the
    // reason it exists.
    expect(sent[0].html).toContain(`https://ceylonhop.com/board.html#/${l.code}`);
  });

  it('does not email again when a repeat join changes nothing', async () => {
    const { app, rideLists, email } = mailApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    await app.request(`/board/${l.code}/join`, json(cookie, {}));

    // The route treats a repeat join as a seat change; an unchanged one is not
    // news, and mailing it would make a refresh look like a second booking.
    expect((email as FakeEmailAdapter).sent).toHaveLength(1);
  });

  it('emails an updated total when the traveller changes their seat count', async () => {
    const { app, rideLists, email } = mailApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }));

    const sent = (email as FakeEmailAdapter).sent;
    expect(sent).toHaveLength(2);
    // 2 x $24.00 — the amount that would actually hit the card.
    expect(sent[1].html).toContain('$48.00');
    expect(sent[1].html).toMatch(/2 seats/i);
  });

  it('still joins the traveller when the mail provider is down', async () => {
    const broken: EmailAdapter = { async send() { throw new Error('provider down'); } };
    const { app, rideLists } = mailApp({}, broken);
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    // The card is already preapproved by this point. Losing the seat because the
    // mail provider blinked would be strictly worse than a missing email.
    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    expect(res.status).toBe(200);
    expect((await res.json()).list.committed).toBe(1);
  });
});

describe('POST /board (create) — the starter gets a receipt too', () => {
  it('emails the traveller who starts a list', async () => {
    const { app, email } = mailApp();
    const cookie = await loginCookie(app);

    const res = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: futureIsoDate(30), slot: 'morning', seats: 1,
    }));
    expect(res.status).toBe(201);
    const code = (await res.json()).list.code;

    // Starting a list auto-joins you as name #1 — the same commitment, so the
    // same receipt.
    const sent = (email as FakeEmailAdapter).sent;
    expect(sent).toHaveLength(1);
    expect(sent[0].html).toContain(code);
  });
});

// Spec 2026-09-22: ops hears about every commitment that moves, on the same hook as the
// traveller's receipt — so it fires on the PayHere callback too, which is where every
// production join actually completes.
describe('Ride Board — ops is told when a seat is held', () => {
  const opsMail = (email: EmailAdapter) => (email as FakeEmailAdapter).sent.filter((m) => m.to === 'ops@x.com');

  it('mails ops when a traveller starts a list, alongside the starter receipt', async () => {
    const { app, email } = opsMailApp();
    const cookie = await loginCookie(app, 'FR');
    const res = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: futureIsoDate(30), slot: 'morning', seats: 1,
    }));
    expect(res.status).toBe(201);
    const code = (await res.json()).list.code;

    const sent = (email as FakeEmailAdapter).sent;
    expect(sent).toHaveLength(2);
    expect(sent.find((m) => m.to === 'roshen@x.com')).toBeTruthy();
    const ops = opsMail(email);
    expect(ops).toHaveLength(1);
    expect(ops[0].subject).toMatch(/^New shared ride: Ella → Mirissa/);
    expect(ops[0].html).toContain(code);
    expect(ops[0].html).toContain('Roshen');
    expect(ops[0].html).toContain('FR');
    expect(ops[0].html).toContain('roshen@x.com');
    expect(ops[0].html).toContain(`https://ops.example/ops?booking=board:${code}`);
  });

  it('mails ops when a traveller joins, with the running seat count', async () => {
    const { app, rideLists, email } = opsMailApp();
    const l = await rideLists.createList(listArgs());
    await rideLists.addMember(l.id, { sub: 'lea-sub', firstName: 'Léa', country: 'FR', email: 'lea@x.com', seats: 1 });
    const cookie = await loginCookie(app);

    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }));
    expect(res.status).toBe(200);

    const ops = opsMail(email);
    expect(ops).toHaveLength(1);
    expect(ops[0].subject).toMatch(/^Seat taken: Ella → Mirissa/);
    expect(ops[0].subject).toContain('(3 of 4 seats)');
    expect(ops[0].html).toContain('2 seats');
  });

  it('mails ops once when PayHere\'s callback completes the join', async () => {
    const email = new FakeEmailAdapter();
    const { app, rideLists, paygw } = makePayHereApp({ email, digestTo: 'ops@x.com', opsBaseUrl: 'https://ops.example' });
    const list = await rideLists.createList(listArgs({ date: '2999-08-08' }));
    const cookie = await loginCookie(app);

    const started = await app.request(`/board/${list.code}/join`, json(cookie, { seats: 1, payment: paymentDetails }));
    expect(started.status).toBe(202);
    // Nothing is held yet, so nothing is announced yet.
    expect(email.sent).toHaveLength(0);

    const { orderId } = (await started.json()).payment;
    const notify = paygw.simulatePreapprovalNotify({ orderId, customerToken: 'real-encrypted-card-token' });
    const res = await app.request('/board/payhere/notify', {
      method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: notify,
    });
    expect(res.status).toBe(200);

    const ops = opsMail(email);
    expect(ops).toHaveLength(1);
    expect(ops[0].subject).toMatch(/^Seat taken/);
    expect(ops[0].html).toContain(list.code);
  });

  it('tells ops when a seat count changes, and stays quiet on an unchanged repeat join', async () => {
    const { app, rideLists, email } = opsMailApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    await app.request(`/board/${l.code}/join`, json(cookie, {}));
    expect(opsMail(email)).toHaveLength(1);

    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 2 }));
    const ops = opsMail(email);
    expect(ops).toHaveLength(2);
    expect(ops[1].subject).toMatch(/^Seats changed: Ella → Mirissa/);
  });

  it('sends nothing internal when no ops inbox is configured', async () => {
    const { app, rideLists, email } = mailApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    expect((email as FakeEmailAdapter).sent.map((m) => m.to)).toEqual(['roshen@x.com']);
  });

  it('still mails ops when the traveller receipt fails, and vice versa, and never fails the join', async () => {
    // A provider that rejects only the customer mail: the ops mail must still go out.
    const flaky = new FakeEmailAdapter();
    const send = flaky.send.bind(flaky);
    flaky.send = async (msg) => {
      if (msg.audience !== 'ops') throw new Error('customer mail down');
      return send(msg);
    };
    const { app, rideLists } = opsMailApp({}, flaky);
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);

    const res = await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    expect(res.status).toBe(200);
    expect(flaky.sent.map((m) => m.to)).toEqual(['ops@x.com']);
  });
});

// A ride closes 24 h before its window opens, so a date that is merely "not in the past" can
// still be past its OWN cutoff. Creating one produced a ride nobody could join (the join route
// 409s a closed list) which the next sweep called off. Seen on production: EA-8707, started
// 2026-09-22 for 2026-09-24, closed 01:30Z that same morning.
describe('POST /board (create) — a ride must still be open when it is started', () => {
  it('400s a date whose cutoff has already passed, and takes nothing from the traveller', async () => {
    const { app, paygw, email } = opsMailApp();
    const cookie = await loginCookie(app);

    const res = await app.request('/board', json(cookie, {
      // TODAY in Colombo — the same function the route measures "past" with, so this is never
      // a date_in_past. Its morning window opened hours ago, so its cutoff passed yesterday: true
      // at every hour, unlike "tomorrow", which stays open until 01:30 UTC and would make this
      // test depend on when CI happens to run.
      from: 'Ella', to: 'Mirissa', date: isoToday(), slot: 'morning', seats: 1,
    }));

    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('cutoff_passed');
    // no card approval stranded, no dead list on the board, nobody emailed about it
    expect(paygw.preapprovals).toHaveLength(0);
    expect((email as FakeEmailAdapter).sent).toHaveLength(0);
  });

  it('still accepts a date far enough out to gather names', async () => {
    const { app } = opsMailApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: futureIsoDate(30), slot: 'morning', seats: 1,
    }));
    expect(res.status).toBe(201);
  });
});

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

  // Added with the five-product narrowing (2026-08-27). This leg was previously priced off
  // the road distance at $29.50, because `ella-south` carried a corridor but no sellable
  // legs; the product it belongs to had been selling on WordPress the whole time. Now that
  // it is in the catalogue the board quotes the scheduled $24, so a pooled van and a
  // scheduled seat on this leg agree — which is the rule this whole suite exists to hold.
  // Mirissa is deliberately NOT on this list: the van runs that road, but Ella -> Mirissa is
  // not sold as a shared seat (owner, 2026-08-27), so it must price off the road distance like
  // any other non-catalogue leg rather than taking the $24 seat fare.
  it('prices the Ella south-coast run from the catalogue, at every drop-off we sell', async () => {
    for (const to of ['Weligama', 'Ahangama']) {
      const app = catalogueApp();
      const cookie = await loginCookie(app);
      const res = await app.request('/board', json(cookie, {
        from: 'Ella', to, date: '2999-08-08', slot: 'morning',
      }));
      expect(res.status, `Ella -> ${to}`).toBe(201);
      expect((await res.json()).list.seatPrice, `Ella -> ${to}`).toBe(2400);
    }
  });

  it('does NOT sell Ella -> Mirissa as a catalogue seat', async () => {
    const app = catalogueApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning',
    }));
    // The road is still a corridor, so a list can exist — it just must not take the $24
    // catalogue fare that Weligama and Ahangama do.
    if (res.status === 201) expect((await res.json()).list.seatPrice).not.toBe(2400);
  });

  it('still prices an off-catalogue leg off the road distance', async () => {
    // CMB -> Kandy rides the airport-cultural corridor (the board only pools pairs a
    // corridor carries) but is not a product we schedule, so it prices off the road
    // distance. (Ella -> Mirissa used to stand here; it became a catalogue leg on
    // 2026-08-27 and now takes the $24 catalogue price.) At 113 km the fare clears the van
    // floor, so this assertion still moves if the distance maths breaks — a short leg like
    // Kandy -> Ella pins to the floor and would pass on any wrong distance.
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Colombo Airport (CMB)', to: 'Kandy', date: '2999-08-08', slot: 'morning',
    }));
    expect(res.status).toBe(201);
    expect((await res.json()).list.seatPrice).toBe(seatPriceForDistance(113)); // fake maps km
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
    // Must be an OFF-catalogue leg: a catalogue leg is priced without asking Google at all,
    // so it would never reach the outage path this test exists to cover.
    const res = await app.request('/board', json(cookie, { from: 'Kandy', to: 'Ella', date: '2999-08-08', slot: 'morning' }));
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
    const res = await app.request('/board', json(cookie, { from: 'Kandy', to: 'Ella', date: '2999-08-08', slot: 'morning' }));
    expect(res.status).toBe(503);
  });
});

describe('POST /board (create)', () => {
  it('creates a list and auto-joins the creator as name #1', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { from: 'Colombo Airport (CMB)', to: 'Kandy', date: '2999-08-08', slot: 'morning', note: 'surfers' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.list.from).toBe('Colombo Airport (CMB)');
    expect(body.list.to).toBe('Kandy');
    // Priced off the road distance via the engine (van fare / 3, to the nearest 50c) rather than
    // the corridor's own hand-set rate — the fake maps return 113 km, so $61.08 van → $20.50 a
    // seat. CMB → Kandy is deliberately an OFF-catalogue leg: a leg we schedule takes its
    // catalogue price instead, which is what the 'catalogue legs' suite above covers.
    expect(body.list.seatPrice).toBe(seatPriceForDistance(113));
    expect(body.list.seatPrice).toBe(2050);
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

// PayHere sends the payer back to return_url / cancel_url. Those were built from APP_BASE_URL,
// which on prod is the apex — still the old WordPress site until cutover — so a traveller who
// approved a card on prod.ceylonhop.com landed on WordPress's 404 (owner, 2026-09-18). The board
// page IS the return page, so the return goes back to the origin the board was used from. Only
// an allow-listed origin qualifies: the CSRF guard already refuses others, and the allow-list is
// what keeps this from being a redirect-anywhere.
describe('PayHere return_url — back to the board the traveller was on', () => {
  const ORIGIN = 'https://ceylonhop.github.io'; // on the default allow-list, not the bookingBaseUrl
  const withOrigin = (cookie: string, body: unknown) => {
    const r = json(cookie, body);
    return { ...r, headers: { ...r.headers, origin: ORIGIN } };
  };

  it('join: returns to the request origin when it is allow-listed', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    expect((await app.request(`/board/${l.code}/join`, withOrigin(cookie, { seats: 1 }))).status).toBe(200);
    expect(paygw.preapprovals[0].returnUrl).toMatch(new RegExp(`^${ORIGIN}/board\\.html\\?ridePayment=`));
    expect(paygw.preapprovals[0].cancelUrl).toMatch(new RegExp(`^${ORIGIN}/board\\.html\\?ridePayment=.*&cancelled=1$`));
  });

  it('create: returns to the request origin when it is allow-listed', async () => {
    const { app, paygw } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', withOrigin(cookie, {
      from: 'Ella', to: 'Mirissa', date: futureIsoDate(30), slot: 'morning', payment: paymentDetails,
    }));
    expect(res.status).toBe(201);
    expect(paygw.preapprovals[0].returnUrl).toMatch(new RegExp(`^${ORIGIN}/board\\.html\\?ridePayment=`));
  });

  it('falls back to the configured base when the caller sends no Origin', async () => {
    const { app, rideLists, paygw } = makeApp({}, { bookingBaseUrl: 'https://ceylonhop.com' });
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    await app.request(`/board/${l.code}/join`, json(cookie, { seats: 1 }));
    expect(paygw.preapprovals[0].returnUrl).toMatch(/^https:\/\/ceylonhop\.com\/board\.html\?ridePayment=/);
  });

  it('never returns to an origin outside the allow-list', async () => {
    const { app, rideLists, paygw } = makeApp();
    const l = await rideLists.createList(listArgs());
    const cookie = await loginCookie(app);
    const r = json(cookie, { seats: 1 });
    const res = await app.request(`/board/${l.code}/join`, { ...r, headers: { ...r.headers, origin: 'https://evil.example' } });
    expect(res.status).toBe(403);
    expect(paygw.preapprovals).toHaveLength(0);
  });
});

// Search sends an off-day traveller to the board to start their own ride (spec
// 2026-09-19-shared-ride-by-day). The other half of that bargain: on a day the SCHEDULED van
// already runs a leg, the board must not start a second van on it — that only splits the same
// travellers across two half-empty vehicles. Whole day, not just the van's slot: a traveller
// who can flex between 7:30am and the afternoon is exactly the one the van needs.
describe('POST /board (create) — a day the scheduled van already runs', () => {
  const WED = 3, THU = 4, SAT = 6;
  function app113km() {
    const rideLists = new InMemoryRideListRepo();
    const paygw = new FakeTokenizedPaymentAdapter();
    const verifier: JwtVerifier = async () => ({
      payload: { iss: 'accounts.google.com', email: 'r@x.com', email_verified: true, name: 'Roshen W', sub: 's', picture: 'p' },
    });
    const maps = {
      provider: 'stub', places: async () => [], distanceVariants: async () => null,
      distance: async () => ({ km: 113, minutes: 180, estimated: false }),
    };
    return { app: createApp({ rideLists, paygw, customerVerifier: verifier, maps: maps as never }), rideLists, paygw };
  }

  for (const [name, weekday] of [['Wednesday', WED], ['Saturday', SAT]] as const) {
    it(`declines a scheduled leg on a ${name} and points at the guaranteed seat`, async () => {
      const { app, paygw } = app113km();
      const cookie = await loginCookie(app);
      const date = nextIsoWeekday(weekday);
      const res = await app.request('/board', json(cookie, {
        from: 'Negombo', to: 'Sigiriya / Dambulla', date, slot: 'afternoon', payment: paymentDetails,
      }));
      expect(res.status).toBe(409);
      expect(await res.json()).toEqual({
        error: 'scheduled_day',
        scheduled: { date, time: '07:30', pickup: 'Zen Cafe, Negombo', seatPrice: 2749 },
      });
      expect(paygw.preapprovals).toHaveLength(0); // no card held for a ride we refused
    });
  }

  it('still starts that leg on a day the van does not run', async () => {
    const { app } = app113km();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, {
      from: 'Negombo', to: 'Sigiriya / Dambulla', date: nextIsoWeekday(THU), slot: 'morning', payment: paymentDetails,
    }));
    expect(res.status).toBe(201);
  });

  it('never blocks a leg we do not sell as a scheduled seat, whatever the day', async () => {
    const { app } = app113km();
    const cookie = await loginCookie(app);
    // on the airport-cultural corridor, but CMB → Kandy is not a scheduled product
    const res = await app.request('/board', json(cookie, {
      from: 'Colombo Airport (CMB)', to: 'Kandy', date: nextIsoWeekday(WED), slot: 'morning', payment: paymentDetails,
    }));
    expect(res.status).toBe(201);
  });
});
