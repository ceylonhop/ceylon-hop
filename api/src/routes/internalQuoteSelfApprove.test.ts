// api/src/routes/internalQuoteSelfApprove.test.ts
// Task 2 of the ops self-approval plan. Kept out of internalQuote.test.ts, whose helpers all
// assume a founder session — every case here is about a role that is NOT the founder.
//
// The shape of the thing being tested: `quote:approve_simple` lets ops move a QUALIFYING quote to
// `ready`, and nothing else. Half these tests exist to prove the "nothing else" — a capability
// that quietly widened would still pass the happy path.
import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryQuoteDiscountRepo } from '../db/quoteDiscountRepo';
import { FakeEmailAdapter } from '../adapters/email';
import { signSession } from '../lib/opsAuth';
import { futureIsoDate } from '../testSupport/dates';

const AUTH = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const jar = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = jar('f@x.com');
const OPS = jar('op@x.com');
const FINANCE = jar('fin@x.com');

function wired(deps: AppDeps = {}) {
  const discounts = new InMemoryQuoteDiscountRepo();
  const quotes = new InMemoryQuoteRepo(discounts);
  const email = new FakeEmailAdapter();
  const app = createApp({
    auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret',
    quotes, quoteDiscounts: discounts, opsManualDiscountsEnabled: true, email,
    opsBaseUrl: 'https://ops.example.com', ...deps,
  });
  return { app, quotes, discounts, email };
}
type Wired = ReturnType<typeof wired>;

const send = (w: Wired, method: string, path: string, body: unknown, cookie: string) =>
  w.app.request(path, {
    method,
    headers: { 'content-type': 'application/json', cookie },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const post = (w: Wired, path: string, body: unknown, cookie = OPS) => send(w, 'POST', path, body, cookie);
const patch = (w: Wired, path: string, body: unknown, cookie = OPS) => send(w, 'PATCH', path, body, cookie);

const SIMPLE = {
  name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, requestedService: 'private',
  legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 }],
};
const TWO_LEG = {
  ...SIMPLE,
  legs: [
    { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 },
    { category: 'transfer', from: 'Kandy', to: 'Colombo', distanceKm: 115 },
  ],
};
const CHAUFFEUR = {
  ...SIMPLE,
  requestedService: 'chauffeur',
  legs: [
    { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: futureIsoDate(30) },
    { category: 'stay_day', from: 'Kandy', to: '', date: futureIsoDate(31) },
    { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: futureIsoDate(32) },
  ],
};

/** Build a quote and leave it in `pending_review`, i.e. one hop from approval. */
async function submitted(w: Wired, body: unknown = SIMPLE, cookie = OPS): Promise<string> {
  const res = await post(w, '/admin/quote/save', body, cookie);
  if (res.status !== 200 && res.status !== 201) throw new Error(`save failed: ${res.status} ${await res.text()}`);
  const { id } = await res.json();
  const sub = await patch(w, `/admin/quote/${id}`, { status: 'pending_review' }, cookie);
  if (sub.status !== 200) throw new Error(`submit failed: ${sub.status} ${await sub.text()}`);
  return id;
}
const approvalMails = (w: Wired) => w.email.sent.filter((m) => /needs your approval/.test(m.subject));

describe('ops self-approval of simple transfers', () => {
  it('lets ops approve a single-leg private transfer they submitted', async () => {
    const w = wired();
    const id = await submitted(w);
    const res = await patch(w, `/admin/quote/${id}`, { status: 'ready' });
    expect(res.status).toBe(200);
    expect((await w.quotes.get(id))!.status).toBe('ready');
  });

  it.each([
    ['a two-leg itinerary', TWO_LEG],
    ['a chauffeur trip', CHAUFFEUR],
    ['the custom vehicle tier', { ...SIMPLE, vehicle: 'custom' }],
    ['a hand-set $/km', { ...SIMPLE, vehicle: 'van_14', customRatePerKmCents: 250 }],
  ])('refuses ops approval of %s', async (_label, body) => {
    const w = wired();
    const id = await submitted(w, body);
    const res = await patch(w, `/admin/quote/${id}`, { status: 'ready' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('approve_forbidden');
    expect((await w.quotes.get(id))!.status).toBe('pending_review');
  });

  it('refuses ops approval of a discounted quote', async () => {
    const w = wired();
    const saved = await (await post(w, '/admin/quote/save', SIMPLE, FOUNDER)).json();
    const discounted = await post(
      w, '/admin/quote/save',
      { ...SIMPLE, id: saved.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } },
      FOUNDER,
    );
    expect(discounted.status).toBe(200);
    expect(await w.discounts.activeFor(saved.id)).not.toBeNull(); // guard: the discount really landed
    await patch(w, `/admin/quote/${saved.id}`, { status: 'pending_review' }, FOUNDER);

    const res = await patch(w, `/admin/quote/${saved.id}`, { status: 'ready' });
    expect(res.status).toBe(403);
  });

  it('gives finance nothing — it holds quote:manage, not quote:approve_simple', async () => {
    const w = wired();
    const id = await submitted(w, SIMPLE, FINANCE);
    const res = await patch(w, `/admin/quote/${id}`, { status: 'ready' }, FINANCE);
    expect(res.status).toBe(403);
  });

  it('leaves the founder able to approve what ops cannot', async () => {
    const w = wired();
    const id = await submitted(w, CHAUFFEUR, FOUNDER);
    expect((await patch(w, `/admin/quote/${id}`, { status: 'ready' }, FOUNDER)).status).toBe(200);
  });

  // ── the "nothing else" half ────────────────────────────────────────────────
  it('still refuses ops a send-back', async () => {
    const w = wired();
    const id = await submitted(w);
    const res = await patch(w, `/admin/quote/${id}`, { status: 'changes_requested' });
    expect(res.status).toBe(403);
  });

  it('still refuses ops the reopening of a sent quote', async () => {
    const w = wired();
    const id = await submitted(w);
    // Assert every hop: without these the quote sits in pending_review, where reopen-to-draft is
    // legal for either role, and this passes while testing nothing of the sort.
    expect((await patch(w, `/admin/quote/${id}`, { status: 'ready' })).status).toBe(200);
    expect((await patch(w, `/admin/quote/${id}`, { status: 'sent' })).status).toBe(200);
    expect((await w.quotes.get(id))!.status).toBe('sent');

    const res = await patch(w, `/admin/quote/${id}`, { status: 'draft' });
    expect(res.status).toBe(403);
  });

  it('still refuses ops a hot-zone edit', async () => {
    const w = wired();
    const res = await post(w, '/admin/quote/zones', { placeName: 'Kandy', boostPct: 10 });
    expect(res.status).toBe(403);
  });

  it('still refuses ops the deletion of a locked quote', async () => {
    const w = wired();
    const id = await submitted(w);
    expect((await patch(w, `/admin/quote/${id}`, { status: 'ready' })).status).toBe(200);
    const res = await send(w, 'DELETE', `/admin/quote/${id}`, undefined, OPS);
    expect(res.status).toBe(403);
  });

  it('still refuses ops a discount', async () => {
    const w = wired();
    const saved = await (await post(w, '/admin/quote/save', SIMPLE)).json();
    const res = await post(w, '/admin/quote/save', {
      ...SIMPLE, id: saved.id, discount: { method: 'fixed', amountCents: 500, reason: 'x' },
    });
    expect(res.status).toBe(403);
  });

  // The whole design rests on content freezing at submission: the predicate is evaluated on the
  // stored row, so a quote that could grow legs after approval would make the gate decorative.
  it('still freezes content once a quote is approved', async () => {
    const w = wired();
    const id = await submitted(w);
    expect((await patch(w, `/admin/quote/${id}`, { status: 'ready' })).status).toBe(200);
    const res = await post(w, '/admin/quote/save', { ...TWO_LEG, id });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
  });

  // ── the awaiting-approval mail ─────────────────────────────────────────────
  // Suppression for self-approvable quotes belongs to Task 4, with the UI: silencing the mail
  // while ops still has no Approve button would strand those quotes unseen. Until then the mail
  // fires for everything, including the quotes ops can approve — noisy, never silent.
  it('still mails the founder when ops submits a quote it could approve itself (until Task 4)', async () => {
    const w = wired();
    await submitted(w, SIMPLE);
    expect(approvalMails(w).map((m) => m.to)).toEqual(['f@x.com']);
  });

  it('still mails the founder when ops submits a quote ops cannot approve', async () => {
    const w = wired();
    await submitted(w, CHAUFFEUR);
    expect(approvalMails(w).map((m) => m.to)).toEqual(['f@x.com']);
  });

  it('still mails the founder when finance submits a simple transfer', async () => {
    const w = wired();
    await submitted(w, SIMPLE, FINANCE);
    expect(approvalMails(w).map((m) => m.to)).toEqual(['f@x.com']);
  });
});

// ── Task 3: mayApprove on the quote detail payload ───────────────────────────
// The page knows the viewer's ROLE but not whether a given quote qualifies, so the answer has to
// travel with the quote. Detail only: approve is rendered in the builder's action bar, and the
// queue has no per-row approve affordance to gate.
describe('GET /admin/quote/:id → mayApprove', () => {
  const detail = async (w: Wired, id: string, cookie: string) =>
    (await (await send(w, 'GET', `/admin/quote/${id}`, undefined, cookie)).json()).mayApprove;

  it('is true for the founder, whatever the quote', async () => {
    const w = wired();
    const simple = await (await post(w, '/admin/quote/save', SIMPLE, FOUNDER)).json();
    const chauffeur = await (await post(w, '/admin/quote/save', CHAUFFEUR, FOUNDER)).json();
    expect(await detail(w, simple.id, FOUNDER)).toBe(true);
    expect(await detail(w, chauffeur.id, FOUNDER)).toBe(true);
  });

  it('is true for ops on a single-leg standard transfer', async () => {
    const w = wired();
    const { id } = await (await post(w, '/admin/quote/save', SIMPLE)).json();
    expect(await detail(w, id, OPS)).toBe(true);
  });

  it.each([
    ['a two-leg itinerary', TWO_LEG],
    ['a chauffeur trip', CHAUFFEUR],
    ['the custom vehicle tier', { ...SIMPLE, vehicle: 'custom' }],
    ['a hand-set $/km', { ...SIMPLE, vehicle: 'van_14', customRatePerKmCents: 250 }],
  ])('is false for ops on %s', async (_label, body) => {
    const w = wired();
    const { id } = await (await post(w, '/admin/quote/save', body)).json();
    expect(await detail(w, id, OPS)).toBe(false);
  });

  // Only the detail path can answer this one: the discount lives on the priced RESULT, which the
  // queue's narrow projection does not carry.
  it('is false for ops once a discount is on the quote', async () => {
    const w = wired();
    const { id } = await (await post(w, '/admin/quote/save', SIMPLE, FOUNDER)).json();
    expect(await detail(w, id, OPS)).toBe(true);

    await post(w, '/admin/quote/save', { ...SIMPLE, id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } }, FOUNDER);
    expect(await detail(w, id, OPS)).toBe(false);
  });

  it('is false for finance on a quote ops could approve', async () => {
    const w = wired();
    const { id } = await (await post(w, '/admin/quote/save', SIMPLE)).json();
    expect(await detail(w, id, OPS)).toBe(true);
    expect(await detail(w, id, FINANCE)).toBe(false);
  });
});
