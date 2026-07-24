import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryRideListRepo, type CreateListArgs } from '../db/rideListRepo';
import { FakeTokenizedPaymentAdapter } from '../adapters/tokenizedPayments';
import type { JwtVerifier } from '../lib/googleAuth';

const listArgs = (over: Partial<CreateListArgs> = {}): CreateListArgs => ({
  corridorId: 'ella-south', fromPlace: 'Ella', toPlace: 'Mirissa', date: '2026-08-08', slot: 'morning',
  minSeats: 4, capacity: 6, seatPrice: 2400, note: null, cutoffAt: new Date('2026-08-06T01:30:00Z'),
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

describe('POST /board (create)', () => {
  it('creates a list and auto-joins the creator as name #1', async () => {
    const { app } = makeApp();
    const cookie = await loginCookie(app);
    const res = await app.request('/board', json(cookie, { from: 'Ella', to: 'Mirissa', date: '2999-08-08', slot: 'morning', note: 'surfers' }));
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.list.from).toBe('Ella');
    expect(body.list.to).toBe('Mirissa');
    expect(body.list.seatPrice).toBe(2400); // ella-south corridor seat price (cents)
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
