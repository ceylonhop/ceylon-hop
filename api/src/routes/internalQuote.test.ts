import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { internalQuoteRoutes } from './internalQuote';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { RATE_CARD } from '../quote/rateCard';
import { signSession } from '../lib/opsAuth';
import { FakeEmailAdapter } from '../adapters/email';

// Fixture auth: 3 allowlisted staff, one per role, over a fixed test secret.
// AUTH matches AppDeps.auth's shape (createApp() overrides); OPS_AUTH_CFG matches the raw
// OpsAuthConfig shape internalQuoteRoutes() itself takes (used when mounting the router
// directly on a bare Hono app, bypassing createApp).
const AUTH = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const OPS_AUTH_CFG = { opsUsers: AUTH.opsUsers, googleClientId: AUTH.googleClientId, sessionSecret: AUTH.opsSessionSecret, adminApiKey: 'k', nodeEnv: 'test' };

// Synchronous session-cookie builder — the same signSession primitive issueSessionCookie
// wraps, called directly so every pre-existing pricing/CSRF test below can attach a real
// ch_ops cookie without an async round trip through a throwaway Hono app.
function cookie(email: string, secret = AUTH.opsSessionSecret): string {
  return `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, secret)}`;
}
const FOUNDER_COOKIE = cookie('f@x.com');

// Default test app: quote:manage requires a session (D-A: all 3 roles get it) — the
// pre-existing pricing/CSRF tests below aren't testing auth, so they run as founder by
// default. createApp() (no override) is reserved for the explicit "no auth" assertions.
type App = ReturnType<typeof realCreateApp>;
function createApp(deps: AppDeps = {}): App {
  return realCreateApp({ auth: AUTH, adminApiKey: 'k', ...deps });
}
function authedGet(app: App, path: string) {
  return app.request(path, { headers: { cookie: FOUNDER_COOKIE } });
}
function post(app: App, path: string, body: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE },
    body: JSON.stringify(body),
  });
}
const leg = (o: Record<string, unknown>) => ({ category: 'transfer', from: 'A', to: 'B', ...o });

describe('internal quoting tool route', () => {
  it('GET /places filters the offline known-place list', async () => {
    const res = await authedGet(createApp(), '/admin/quote/places?q=kand');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.places).toEqual(['Kandy']);
    expect(body.suggestions).toEqual([{ label: 'Kandy', source: 'known' }]);
  });

  it('GET /places returns [] for a too-short query', async () => {
    expect((await (await authedGet(createApp(), '/admin/quote/places?q=k')).json()).places).toEqual([]);
  });

  it('POST /distance returns km + duration for known places', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Colombo City', to: 'Kandy' });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.km).toBeGreaterThan(0);
    expect(d.durationMin).toBeGreaterThan(0);
  });

  it('POST /distance is 404 for an unknown route', async () => {
    const res = await post(createApp(), '/admin/quote/distance', { from: 'Nowhereville', to: 'Kandy' });
    expect(res.status).toBe(404);
  });

  it('estimate finishes a private leg after its 3542¢ core price; no drafts; lineItems carry cents', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      name: 'Test', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.total.cents).toBe(3550);
    expect(d.amountDueNow.cents).toBe(3550); // private → full
    expect(d.drafts).toBeUndefined(); // V15: dead drafts removed
    expect(Number.isInteger(d.lineItems[0].amountCents)).toBe(true); // Fix 7: cents on line items
    expect(d.lineItems[0].meta.billableKm).toBe(88); // meta passthrough — client zips travel items with legs
    expect(d.lineItems.at(-1)).toMatchObject({
      label: 'Final price adjustment',
      amountCents: 8,
      meta: { kind: 'price_adjustment', strategy: 'nearest_50_cents' },
    });
    expect(d.comparison).toBeUndefined(); // reflow: car/van comparison removed
    // reflow: services chooser replaces comparison. Single undated leg → chauffeur infeasible.
    expect(d.services.pointToPoint.total.cents).toBe(3550);
    expect(d.services.chauffeur.error).toBeTruthy();
  });

  it('an empty-string date on an undated private leg is treated as absent, not invalid', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80, date: '' })],
    });
    expect(res.status).toBe(200); // regression: the tool always sends date:'' for undated legs
  });

  it('estimate auto-resolves the distance from known places when km is omitted', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBeGreaterThan(0);
  });

  it('estimate is 400 when distance is unknown and no manual km is given', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'Nowhereville', to: 'Kandy' }],
    });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with no legs', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with only a stay day (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' }],
    });
    expect(res.status).toBe(400);
  });

  it('addSightseeingFee toggle adds the $10 sightseeing extra vs a plain transfer', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const withS = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80, addSightseeingFee: true })] })).json();
    expect(withS.total.cents).toBe(base.total.cents + 1000);
  });

  it('POST /save persists a priced quote and returns a Q- reference; total matches /estimate', async () => {
    const app = createApp();
    const bodyReq = { firstName: 'Maya', lastName: 'Silva', contact: '+34600', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] };
    const est = await (await post(app, '/admin/quote/estimate', bodyReq)).json();
    const res = await post(app, '/admin/quote/save', bodyReq);
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.reference).toMatch(/^Q-[A-HJ-NP-Z2-9]{5}$/); // 5 chars, unambiguous alphabet (no 0/O/1/I)
    expect(saved.status).toBe('draft');
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(est.total.cents); // saved total == previewed total
    const adjustmentItem = got.result.lineItems.find((item: { meta?: { kind?: string } }) => item.meta?.kind === 'price_adjustment');
    const baseItems = got.result.lineItems.filter((item: { meta?: { kind?: string } }) => item.meta?.kind !== 'price_adjustment');
    expect(got.result.subtotalCents).toBe(baseItems.reduce((sum: number, item: { amountCents: number }) => sum + item.amountCents, 0));
    expect(got.result.priceAdjustmentCents).toBe(adjustmentItem?.amountCents ?? 0);
    expect(got.result.totalCents).toBe(est.total.cents);
    // This request posts firstName/lastName, so the stored customer_name is the joined pair.
    expect(got.customerName).toBe('Maya Silva');
    expect(got.request.tool.firstName).toBe('Maya');
    expect(got.request.tool.lastName).toBe('Silva');
    expect(got.rateCardVersion).toBe('2026-07-14');
  });

  it('POST /save with an existing id updates that quote in place, keeping its id/reference/status', async () => {
    const app = createApp();
    const saved = await (await post(app, '/admin/quote/save', { name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] })).json();
    // Move it into review, then re-save with edited content carrying the same id.
    await patch(app, `/admin/quote/${saved.id}`, { status: 'pending_review' });
    const res = await post(app, '/admin/quote/save', { id: saved.id, name: 'Maya R.', vehicle: 'van_6', passengerCount: 4, luggageCount: 3, legs: [leg({ distanceKm: 120 })] });
    expect(res.status).toBe(200); // updated, not created
    const back = await res.json();
    expect(back.id).toBe(saved.id);              // same row
    expect(back.reference).toBe(saved.reference); // stable reference
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.status).toBe('pending_review');   // a content edit doesn't reset the lifecycle
    expect(got.customerName).toBe('Maya R.');
    expect(got.vehicle).toBe('van'); // engine stores the tier as 'van' (van_6 → van)
    // Exactly one quote exists — the edit did not orphan a duplicate.
    const list = await (await authedGet(app, '/admin/quote/list')).json();
    expect(list.quotes.length).toBe(1);
  });

  it('POST /save on a READY (approved) quote is rejected (409) — maker-checker lock', async () => {
    const app = createApp();
    const saved = await (await post(app, '/admin/quote/save', { name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] })).json();
    await patch(app, `/admin/quote/${saved.id}`, { status: 'ready' }); // founder-approved, content now locked
    const res = await post(app, '/admin/quote/save', { id: saved.id, name: 'Cheaper', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 5 })] });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('not_editable');
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.customerName).toBe('Maya'); // approved content untouched
  });

  it('POST /save with an unknown id falls back to creating a new quote (201)', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', { id: 'no-such-id', vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.id).not.toBe('no-such-id');
  });

  it('POST /save re-prices server-side and ignores any client-supplied total', async () => {
    const app = createApp();
    const res = await post(app, '/admin/quote/save', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, total: 999999, totalCents: 999999, legs: [leg({ distanceKm: 80 })],
    });
    const saved = await res.json();
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(3550); // finished engine price, not the bogus client total
  });

  it('POST /save is 400 for an unpriceable trip (no travel leg)', async () => {
    const res = await post(createApp(), '/admin/quote/save', {
      vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'stay_day', from: 'Kandy', to: '' }],
    });
    expect(res.status).toBe(400); // stay-day-only → no travel leg
  });

  const patch = (app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: FOUNDER_COOKIE }, body: JSON.stringify(body) });

  it('GET /list returns saved quotes newest-first and filters by status/product', async () => {
    const app = createApp();
    const a = await (await post(app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    await new Promise((r) => setTimeout(r, 5)); // distinct createdAt — same-ms ties order by reference, not insertion
    const b = await (await post(app, '/admin/quote/save', { vehicle: 'van_6', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    const list = await (await authedGet(app, '/admin/quote/list')).json();
    expect(list.quotes[0].id).toBe(b.id); // newest first
    // reach 'won' the legal way: draft → ready (founder self-approve) → won
    await patch(app, `/admin/quote/${a.id}`, { status: 'ready' });
    await patch(app, `/admin/quote/${a.id}`, { status: 'won' });
    const won = await (await authedGet(app, '/admin/quote/list?status=won')).json();
    expect(won.quotes.map((q: { id: string }) => q.id)).toEqual([a.id]);
  });

  it('PATCH /:id moves status, stamps timestamps, records lost_reason; 404 unknown; 400 bad status', async () => {
    const app = createApp();
    const q = await (await post(app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    await patch(app, `/admin/quote/${q.id}`, { status: 'ready' }); // draft → ready (self-approve)
    const sent = await (await patch(app, `/admin/quote/${q.id}`, { status: 'sent' })).json();
    expect(sent.status).toBe('sent');
    expect(sent.sentAt).not.toBeNull();
    const lost = await (await patch(app, `/admin/quote/${q.id}`, { status: 'lost', lostReason: 'too expensive' })).json();
    expect(lost.decidedAt).not.toBeNull();
    expect(lost.lostReason).toBe('too expensive');
    expect((await patch(app, '/admin/quote/00000000-0000-0000-0000-000000000000', { status: 'won' })).status).toBe(404);
    expect((await patch(app, `/admin/quote/${q.id}`, { status: 'bogus' })).status).toBe(400);
  });

  it('PATCH /:id rejects a non-string lostReason/notes with 400 (validated, not cast to the DB)', async () => {
    const app = createApp();
    const q = await (await post(app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();
    expect((await patch(app, `/admin/quote/${q.id}`, { lostReason: { evil: true } })).status).toBe(400);
    expect((await patch(app, `/admin/quote/${q.id}`, { notes: 123 })).status).toBe(400);
  });

  // ── Maker-checker approval gate ────────────────────────────────────────────
  const patchAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const postAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const draft = async (app: App, email = 'f@x.com') => {
    const r = await postAs(email, app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    return r.json();
  };

  it('ops can submit a draft for review but cannot approve or self-approve', async () => {
    const app = createApp();
    const id = (await draft(app, 'op@x.com')).id;
    expect((await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'pending_review' })).status).toBe(200);
    const forbid = await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'ready' });
    expect(forbid.status).toBe(403);
    expect((await forbid.json()).error).toBe('approve_forbidden');
    const id2 = (await draft(app, 'op@x.com')).id; // self-approve draft → ready also blocked
    expect((await patchAs('op@x.com', app, `/admin/quote/${id2}`, { status: 'ready' })).status).toBe(403);
  });

  it('founder approves a pending_review quote and can self-approve a draft', async () => {
    const app = createApp();
    const a = (await draft(app)).id;
    await patchAs('f@x.com', app, `/admin/quote/${a}`, { status: 'pending_review' });
    expect((await patchAs('f@x.com', app, `/admin/quote/${a}`, { status: 'ready' })).status).toBe(200);
    const b = (await draft(app)).id;
    expect((await patchAs('f@x.com', app, `/admin/quote/${b}`, { status: 'ready' })).status).toBe(200); // self-approve
  });

  it('rejects an illegal transition (draft → sent) with 409', async () => {
    const app = createApp();
    const id = (await draft(app, 'op@x.com')).id;
    const r = await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'sent' });
    expect(r.status).toBe(409);
    expect((await r.json()).error).toBe('illegal_transition');
  });

  it('reopens a SENT quote to draft (founder-only), unlocking it for edits + re-save', async () => {
    const app = createApp();
    const id = (await draft(app)).id;
    await patchAs('f@x.com', app, `/admin/quote/${id}`, { status: 'ready' });
    await patchAs('f@x.com', app, `/admin/quote/${id}`, { status: 'sent' });

    // while sent, a content re-save is refused (the bug the operator hit)
    const locked = await postAs('f@x.com', app, '/admin/quote/save', { id, vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 90 })] });
    expect(locked.status).toBe(409);
    expect((await locked.json()).error).toBe('not_editable');

    // a support role cannot pull a sent quote back
    const forbid = await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'draft' });
    expect(forbid.status).toBe(403);
    expect((await forbid.json()).error).toBe('approve_forbidden');

    // the founder can — sent → draft, dropping the rate lock
    const reopened = await patchAs('f@x.com', app, `/admin/quote/${id}`, { status: 'draft' });
    expect(reopened.status).toBe(200);
    expect((await reopened.json()).status).toBe('draft');

    // now editable again — the re-save that 409'd above succeeds
    const resave = await postAs('f@x.com', app, '/admin/quote/save', { id, vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 90 })] });
    expect(resave.ok).toBe(true);
  });

  it('accepts an injected QuoteRepo without breaking existing routes', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await authedGet(app, '/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
  });

  it('a ready quote ships a locked estimate with per-leg breakdown AND both service rates', async () => {
    const app = createApp();
    // multi-leg on two distinct dates → chauffeur is offered alongside point-to-point
    const saved = await (await post(app, '/admin/quote/save', {
      name: 'Brett', vehicle: 'van_9', passengerCount: 4, luggageCount: 4,
      legs: [leg({ distanceKm: 130, date: '2026-08-27' }), leg({ distanceKm: 290, date: '2026-08-31' })],
    })).json();
    await patch(app, `/admin/quote/${saved.id}`, { status: 'ready' });

    const q = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(q.status).toBe('ready');
    // per-leg breakdown → the itinerary rows can show each leg's price (were "—")
    expect(q.estimate.breakdown.legs).toHaveLength(2);
    expect(q.estimate.breakdown.legs[0].priceCents).toBeGreaterThan(0);
    // both service rates → the Point-to-point / Chauffeur-guide comparison boxes (were "—")
    expect(q.estimate.services.pointToPoint.total).toBeTruthy();
    expect(q.estimate.services.chauffeur.total).toBeTruthy();
  });

  it('chauffeur: stay days become idle days; amountDueNow is the full total', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: '', date: '2026-02-15' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.product).toBe('chauffeur');
    expect(d.amountDueNow.cents).toBe(d.total.cents);
    expect(d.deposit.cents).toBeLessThanOrEqual(5000); // cap
  });

  it('derives chauffeur when a leg has a stay day (no explicit service)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: 'Kandy', date: '2026-02-15' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).product).toBe('chauffeur');
  });

  it('a plain transfer itinerary is private', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }],
    });
    const d = await res.json();
    expect(d.product).toBe('private');
    expect(d.total.cents).toBe(8300); // raw van price 8324¢ → nearest-50¢ final price
  });

  it('sightseeing/waiting/safari-wait toggles add engine extras on a private trip', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }] })).json();
    const withFees = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, addSightseeingFee: true, addWaitingFee: true, addSafariWait: true }] })).json();
    expect(withFees.total.cents).toBe(base.total.cents + 1000 + 1000 + 1900); // sightseeing $10 + waiting $10 + safari-wait $19
  });

  it('van_9/van_14/custom are no longer gated — they price correctly (200, total > 0)', async () => {
    const cases: Array<{ vehicle: string; pax: number; expectedCents: number }> = [
      { vehicle: 'van_9',  pax: 8,  expectedCents: 8300 }, // raw 8324¢ → nearest-50¢
      { vehicle: 'van_14', pax: 12, expectedCents: 8500 }, // raw 8501¢ → nearest-50¢
      { vehicle: 'custom', pax: 20, expectedCents: 30900 }, // raw 30993¢ → eligible $309 charm price
    ];
    for (const { vehicle, pax, expectedCents } of cases) {
      const res = await post(createApp(), '/admin/quote/estimate', {
        vehicle, passengerCount: pax, luggageCount: 2,
        legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 140 }],
      });
      expect(res.status).toBe(200);
      const d = await res.json();
      expect(d.total.cents).toBe(expectedCents); // 140km → 154 billableKm
      expect(d.total.cents).toBeGreaterThan(0);
    }
  });

  it('estimate includes a breakdown (km strip + per-leg prices)', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'van_6', passengerCount: 4, luggageCount: 4, legs: [{ category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 }] })).json();
    expect(d.breakdown.km).toEqual({ distanceKm: 140, bufferKm: 14, billableKm: 154 });
    expect(d.breakdown.legs[0].priceCents).toBe(8324);
  });

  it('GET /rate-card returns the locked rate card for the read-only Settings (all 5 tiers) + vehicle caps', async () => {
    const d = await (await authedGet(createApp(), '/admin/quote/rate-card')).json();
    expect(d.version).toBe('2026-07-14');
    expect(d.perKmCents).toMatchObject({ car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 });
    expect(d.floorCents).toMatchObject({ car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 });
    expect(d.chauffeurDayRateCents).toBe(3105);
    expect(d.fxUsdToLkr).toBe(330);
    // V12 server half: expose vehicle capacity caps for client-side vehicle labelling
    expect(d.vehicle).toMatchObject({
      car: { maxPax: 3, maxBags: 3 },
      van: { maxPax: 6, maxBags: 6 },
      van9: { maxPax: 9, maxBags: 8 },
      van14: { maxPax: 14, maxBags: 12 },
      custom: { maxPax: 99, maxBags: 99 },
    });
  });

  // Fix 1 (V18): Zod validation on /estimate.
  it('estimate is 400 when passengerCount is 0', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 0, luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
  });

  it('estimate is 400 when passengerCount is missing', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', luggageCount: 0, legs: [leg({ distanceKm: 80 })] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 with a Zod-rejected empty legs array', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 for a bad leg category', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'teleport', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  it('estimate is 400 when a chauffeur itinerary has any undated leg (dates required on every leg incl. stay)', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'stay_day', from: 'Kandy', to: '' }, // undated → should reject
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/date/i);
  });

  // Legs are the only concept now (owner decision: a via-request = two same-date legs).
  // A plain leg with a missing km still auto-resolves via the maps adapter…
  it('estimate auto-resolves a single leg\'s distance via the maps adapter when km is omitted', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy' }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBeGreaterThan(0);
  });

  // …and an unresolvable leg still 400s naming the failing segment.
  it('estimate is 400 when a leg\'s distance cannot be resolved', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Nowhereville' }],
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/couldn't find the distance/i);
  });

  // Reflow: `services` chooser replaces the car/van comparison.
  it('services: a multi-day dated 2-leg itinerary prices BOTH pointToPoint and chauffeur', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    })).json();
    expect(d.product).toBe('private'); // selected service drives the detailed response
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.deposit.cents).toBeLessThanOrEqual(5000); // chauffeur deposit cap
    expect(d.services.chauffeur.amountDueNow.cents).toBe(d.services.chauffeur.total.cents);
    expect(d.comparison).toBeUndefined();
  });

  it('services: selecting chauffeur drives the detailed response and still prices pointToPoint', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
      ],
    })).json();
    expect(d.product).toBe('chauffeur');
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.total.cents).toBeGreaterThan(0);
  });

  it('services: a single-day itinerary returns chauffeur error "single-day"', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-14' },
      ],
    })).json();
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.error).toMatch(/single-day/i);
  });

  it('a single-day itinerary asked to price as chauffeur is reverted to point-to-point (no day rate)', async () => {
    // Two legs on the SAME date = one distinct date → chauffeur is infeasible. Even when the
    // caller explicitly requests `service: 'chauffeur'`, the backend must price point-to-point
    // (no day rate), mirroring the ops UI's client-side revert — the backend is the canonical,
    // tamper-proof price + the save-time recompute.
    const legs = [
      { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14' },
      { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-14' },
    ];
    const chauf = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs,
    })).json();
    const priv = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs,
    })).json();
    expect(chauf.product).toBe('private'); // reverted, not chauffeur
    expect(chauf.total.cents).toBe(priv.total.cents); // priced exactly as point-to-point — no day rate
    expect(chauf.services.chauffeur.error).toMatch(/single-day/i); // chooser still shows chauffeur disabled
  });

  it('services: an undated multi-leg itinerary returns chauffeur error "add a date"', async () => {
    const d = await (await post(createApp(), '/admin/quote/estimate', {
      service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120 },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140 },
      ],
    })).json();
    expect(d.services.pointToPoint.total.cents).toBeGreaterThan(0);
    expect(d.services.chauffeur.error).toMatch(/add a date/i);
  });

  it('service:chauffeur does NOT charge sightseeing (engine rule); private DOES (+1000)', async () => {
    const legs = [
      { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: '2026-02-14', addSightseeingFee: true },
      { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: '2026-02-16' },
    ];
    const priv = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs })).json();
    const privNoFee = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: legs.map((l) => ({ ...l, addSightseeingFee: false })) })).json();
    expect(priv.total.cents).toBe(privNoFee.total.cents + 1000); // private charges sightseeing

    const chauf = await (await post(createApp(), '/admin/quote/estimate', { service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs })).json();
    const chaufNoFee = await (await post(createApp(), '/admin/quote/estimate', { service: 'chauffeur', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: legs.map((l) => ({ ...l, addSightseeingFee: false })) })).json();
    expect(chauf.total.cents).toBe(chaufNoFee.total.cents); // chauffeur does NOT charge sightseeing
  });

  it('estimate rejects category "sightseeing" (no longer a valid leg category) with 400', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'sightseeing', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  it('estimate rejects category "safari_wait" (now a toggle, not a category) with 400', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'safari_wait', from: 'A', to: 'B', distanceKm: 80 }] });
    expect(res.status).toBe(400);
  });

  // Fix 8 (V19): /save persists the reopenable tool payload under request.tool (+ engine req).
  it('POST /save stores request.tool and request.engine for reopening', async () => {
    const app = createApp();
    const body = { name: 'Reo', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [{ category: 'transfer', from: 'Colombo City', to: 'Kandy', distanceKm: 100 }] };
    const res = await post(app, '/admin/quote/save', body);
    expect(res.status).toBe(201);
    const saved = await res.json();
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.request.tool.legs[0].from).toBe('Colombo City');
    expect(got.request.engine).toBeTruthy();
    expect(got.request.engine.product).toBe('private');
  });

  // Legs-only decision: an OLD saved quote whose request.tool legs still carry a `stopovers`
  // array (persisted before this change) must still reopen/reprice fine — Zod strips the
  // unknown key rather than rejecting the payload.
  it('re-pricing an old saved quote whose tool legs carry a leftover stopovers array still works', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      vehicle: 'car', passengerCount: 2, luggageCount: 2,
      legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, stopovers: ['Old Data'] }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()).total.cents).toBe(3550);
  });
});

// D-A (2026-07-04): the quote tool opens to ALL THREE roles via quote:manage — reverts #14's
// founder-only gate. x-admin-key resolves to `system`, which lacks quote:manage (403) — a
// behavior change from pre-reconciliation, where the key was a founder backdoor here.
describe('quote tool authorization (D-A: all 3 roles get quote:manage)', () => {
  it('GET / redirects to /ops (302) without needing auth', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const res = await app.request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });

  it('rejects the data routes without a session (401)', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    expect((await app.request('/admin/quote/list')).status).toBe(401);
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
  });

  it('rejects a forged/garbage cookie (401)', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const res = await app.request('/admin/quote/list', { headers: { cookie: 'ch_ops=deadbeef.deadbeef' } });
    expect(res.status).toBe(401);
  });

  it('rejects a cookie signed with the wrong secret (401)', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const res = await app.request('/admin/quote/list', { headers: { cookie: await cookie('f@x.com', 'wrong-secret') } });
    expect(res.status).toBe(401);
  });

  it('x-admin-key is REJECTED on quote routes (system lacks quote:manage) — behavior change from pre-reconciliation', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const res = await app.request('/admin/quote/list', { headers: { 'x-admin-key': 'k' } });
    expect(res.status).toBe(403);
  });

  it('founder, finance, and ops sessions all reach /rate-card (quote:manage, not founder-only)', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    for (const email of ['f@x.com', 'fin@x.com', 'op@x.com']) {
      const res = await app.request('/admin/quote/rate-card', { headers: { cookie: await cookie(email) } });
      expect(res.status).toBe(200);
    }
  });

  it('founder, finance, and ops sessions all reach /list', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    for (const email of ['f@x.com', 'fin@x.com', 'op@x.com']) {
      const res = await app.request('/admin/quote/list', { headers: { cookie: await cookie(email) } });
      expect(res.status).toBe(200);
    }
  });
});

describe('quote tool — margin stripped for non-margin:view roles (server-side, per response)', () => {
  const estimateBody = { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [leg({ distanceKm: 100 })] };

  it('omits margin from /estimate for finance and ops sessions, includes it for founder', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    for (const email of ['fin@x.com', 'op@x.com']) {
      const res = await app.request('/admin/quote/estimate', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie(email) }, body: JSON.stringify(estimateBody),
      });
      const body = await res.json();
      expect(body).not.toHaveProperty('margin');
    }
    const fRes = await app.request('/admin/quote/estimate', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') }, body: JSON.stringify(estimateBody),
    });
    expect(await fRes.json()).toHaveProperty('margin');
  });

  it('omits margin from /save\'s persisted quote when read back (/:id) for finance and ops, includes it for founder', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const saveOnce = async (email: string) => {
      const res = await app.request('/admin/quote/save', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie(email) }, body: JSON.stringify(estimateBody),
      });
      expect(res.status).toBe(201);
      return res.json();
    };
    for (const email of ['fin@x.com', 'op@x.com']) {
      const saved = await saveOnce(email);
      const body = await (await app.request(`/admin/quote/${saved.id}`, { headers: { cookie: await cookie(email) } })).json();
      expect(body).not.toHaveProperty('marginCents');
      // The persisted `result` is a full QuoteResult; its marginEstimateCents is the same
      // cost figure — it must NOT leak nested for finance/ops (regression: shallow strip left it).
      expect(body.result?.marginEstimateCents ?? null).toBeNull();
    }
    const saved = await saveOnce('f@x.com');
    const body = await (await app.request(`/admin/quote/${saved.id}`, { headers: { cookie: await cookie('f@x.com') } })).json();
    expect(body).toHaveProperty('marginCents');
    expect(body.result.marginEstimateCents).toBeGreaterThan(0); // founder still sees nested margin
  });

  it('omits margin from PATCH /:id\'s updated quote for finance and ops, includes it for founder', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    const save = async (email: string) => {
      const res = await app.request('/admin/quote/save', {
        method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie(email) }, body: JSON.stringify(estimateBody),
      });
      return res.json();
    };
    // Submit-for-review is a legal move for every role (finance/ops have quote:manage) — the point
    // of this test is that the PATCH RESPONSE strips margin for non-margin:view roles, not the status.
    const patchStatus = async (id: string, email: string) =>
      app.request(`/admin/quote/${id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json', cookie: await cookie(email) }, body: JSON.stringify({ status: 'pending_review' }),
      });
    for (const email of ['fin@x.com', 'op@x.com']) {
      const saved = await save(email);
      const res = await patchStatus(saved.id, email);
      expect(res.status).toBe(200);
      const body = await res.json();
      expect(body).not.toHaveProperty('marginCents'); // routine status edit must not leak cost/margin
      expect(body.result?.marginEstimateCents ?? null).toBeNull(); // nor nested in result
    }
    const saved = await save('f@x.com');
    const res = await patchStatus(saved.id, 'f@x.com');
    const body = await res.json();
    expect(body).toHaveProperty('marginCents');
    expect(body.result.marginEstimateCents).toBeGreaterThan(0);
  });

  // [CORRECTED 2026-07-04 during T-D]: QuoteSummary (GET /list's return type, db/quoteRepo.ts)
  // carries no marginCents field at all — toSummary() never populates one. So /list has
  // nothing to strip, for ANY role; this test documents that invariant rather than asserting
  // a founder-vs-non-founder difference that doesn't exist. If marginCents is ever added to
  // QuoteSummary, this test must be updated to assert the per-role strip (see the code
  // comment above GET /list in internalQuote.ts).
  it('never exposes marginCents via /list, for any role (QuoteSummary carries no such field)', async () => {
    const app = createApp({ auth: AUTH, adminApiKey: 'k' });
    await app.request('/admin/quote/save', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') }, body: JSON.stringify(estimateBody),
    });
    for (const email of ['fin@x.com', 'op@x.com', 'f@x.com']) {
      const list = await (await app.request('/admin/quote/list', { headers: { cookie: await cookie(email) } })).json();
      expect(list.quotes.length).toBeGreaterThan(0);
      for (const q of list.quotes) expect(q).not.toHaveProperty('marginCents');
    }
  });
});

// GL-1d: van14/custom are custom-priced per quote — the tool sends customRatePerKmCents.
describe('quoting tool — custom per-km rate for Van 14 / Custom', () => {
  const openApp = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), auth: OPS_AUTH_CFG }));
    return a;
  };
  const estimate = async (body: unknown) =>
    openApp().request('/admin/quote/estimate', {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', cookie: await cookie('f@x.com') },
    });

  it('van_14 + customRatePerKmCents prices at the overridden rate', async () => {
    const res = await estimate({
      vehicle: 'van_14', passengerCount: 12, luggageCount: 8, service: 'private',
      legs: [{ from: 'A', to: 'B', distanceKm: 140 }],
      customRatePerKmCents: 90,
    });
    expect(res.status).toBe(200);
    const j = await res.json();
    expect(j.total.cents).toBe(13850); // raw 154km × 90¢ = 13860¢, then nearest-50¢
  });

  it('400s a custom rate on a non-custom tier (car)', async () => {
    const res = await estimate({
      vehicle: 'car', passengerCount: 2, luggageCount: 1, service: 'private',
      legs: [{ from: 'A', to: 'B', distanceKm: 100 }],
      customRatePerKmCents: 90,
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Van 14|Custom/);
  });
});

// GL-1c: the tool stores customer PII and exposes cost/margin. The guard must fail CLOSED —
// no auth at all (no session, no x-admin-key) never reaches a data route.
describe('quoting tool — fail-closed with no auth', () => {
  const locked = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), auth: OPS_AUTH_CFG }));
    return a;
  };

  it('401s data routes with no session and no key', async () => {
    const app = locked();
    expect((await app.request('/admin/quote/places?q=kand')).status).toBe(401);
    expect((await app.request('/admin/quote/list')).status).toBe(401);
    const est = await app.request('/admin/quote/estimate', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    expect(est.status).toBe(401);
  });

  it('still redirects GET / to /ops when locked (the redirect carries no quote data)', async () => {
    const res = await locked().request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });

  it('a valid session (any of the 3 roles) unlocks the data routes via quote:manage', async () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({ maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(), auth: OPS_AUTH_CFG }));
    const res = await a.request('/admin/quote/places?q=kand', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
  });
});

describe('quoting tool — /places delegates to the maps adapter', () => {
  it('returns local known places before adapter-backed Google suggestions', async () => {
    const a = new Hono();
    const stubMaps = { provider: 'stub', places: async (q: string) => [`Stubbed`, q].slice(0, 1), distance: async () => null };
    a.route('/admin/quote', internalQuoteRoutes({ maps: stubMaps, quotes: new InMemoryQuoteRepo(), auth: OPS_AUTH_CFG }));
    const res = await a.request('/admin/quote/places?q=colombo', { headers: { cookie: await cookie('op@x.com') } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.places.slice(0, 2)).toEqual(['Colombo Airport (CMB)', 'Colombo City']);
    expect(body.suggestions[0]).toEqual({ label: 'Colombo Airport (CMB)', source: 'known' });
    expect(body.suggestions.some((p: { label: string; source: string }) => p.label === 'Stubbed' && p.source === 'google')).toBe(true);
  });

  it('returns [] for a too-short query without touching the adapter', async () => {
    const a = new Hono();
    let called = false;
    const stubMaps = { provider: 'stub', places: async (q: string) => { called = q.length >= 0; return ['Nope']; }, distance: async () => null };
    a.route('/admin/quote', internalQuoteRoutes({ maps: stubMaps, quotes: new InMemoryQuoteRepo(), auth: OPS_AUTH_CFG }));
    const res = await a.request('/admin/quote/places?q=c', { headers: { cookie: await cookie('op@x.com') } });
    expect((await res.json()).places).toEqual([]);
    expect(called).toBe(false);
  });
});

// Ops⇄quote merge T2: the standalone quote shell is retired — GET / is a plain 302 to /ops
// (where the tool now lives). The old toolHtml()/readFileSync resilience suite went with it.
describe('quoting tool — GET / redirects to /ops', () => {
  it('app-level: GET /admin/quote → 302 with location /ops', async () => {
    const res = await createApp().request('/admin/quote');
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/ops');
  });
});

// Ops⇄quote merge T2: CSRF on the state-changing routes. A founder's browser holds an ambient
// ch_ops cookie, so a cross-site page could otherwise fire authenticated POSTs. Mutations check
// Sec-Fetch-Site first (modern browsers), then fall back to the Origin allow-list (older ones).
// Neither header present = non-browser caller (curl/fetch from scripts) — the auth guard still
// applies. GET reads stay CSRF-exempt: autocomplete must stay fast and reads carry no writes.
describe('quoting tool — CSRF (Sec-Fetch-Site/Origin) on mutations', () => {
  const OWN_ORIGIN = 'http://localhost:4173'; // in the app's default ALLOWED_ORIGINS
  const founder = FOUNDER_COOKIE;
  const build = () => {
    const a = new Hono();
    a.route('/admin/quote', internalQuoteRoutes({
      maps: new FakeMapsAdapter(), quotes: new InMemoryQuoteRepo(),
      auth: OPS_AUTH_CFG, allowedOrigins: [OWN_ORIGIN],
    }));
    return a;
  };
  const estimateBody = JSON.stringify({
    vehicle: 'car', passengerCount: 1, luggageCount: 0,
    legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }],
  });
  const estimate = (headers: Record<string, string>) =>
    build().request('/admin/quote/estimate', {
      method: 'POST', body: estimateBody,
      headers: { cookie: founder, 'content-type': 'application/json', ...headers },
    });

  it('403 bad_origin on Sec-Fetch-Site: cross-site, even with a valid founder cookie', async () => {
    const res = await estimate({ 'sec-fetch-site': 'cross-site' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('403 bad_origin on a disallowed Origin when Sec-Fetch-Site is absent (older browsers)', async () => {
    const res = await estimate({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  it('passes with an allow-listed Origin (the app\'s own serving origin)', async () => {
    const res = await estimate({ origin: OWN_ORIGIN });
    expect(res.status).toBe(200);
  });

  it('passes on Sec-Fetch-Site: same-origin even when Origin is not allow-listed', async () => {
    // A same-origin /ops POST from a host not in ALLOWED_ORIGINS (e.g. a preview port) must
    // still work — Sec-Fetch-Site is authoritative and pre-empts the Origin allow-list.
    const res = await estimate({ 'sec-fetch-site': 'same-origin', origin: 'http://localhost:59999' });
    expect(res.status).toBe(200);
  });

  it('passes with neither header (non-browser caller; the auth guard still protects)', async () => {
    const res = await estimate({});
    expect(res.status).toBe(200);
  });

  it('covers every mutation: POST /distance, POST /save, PATCH /:id all 403 cross-site', async () => {
    const app = build();
    const bad = { cookie: founder, 'content-type': 'application/json', 'sec-fetch-site': 'cross-site' };
    const dist = await app.request('/admin/quote/distance', { method: 'POST', headers: bad, body: '{"from":"A","to":"B"}' });
    expect(dist.status).toBe(403);
    expect((await dist.json()).error).toBe('bad_origin');
    const save = await app.request('/admin/quote/save', { method: 'POST', headers: bad, body: estimateBody });
    expect(save.status).toBe(403);
    const patch = await app.request('/admin/quote/some-id', { method: 'PATCH', headers: bad, body: '{"status":"won"}' });
    expect(patch.status).toBe(403);
  });

  it('GET reads are exempt — a cross-site Sec-Fetch-Site still reads /rate-card and /list', async () => {
    const app = build();
    const headers = { cookie: founder, 'sec-fetch-site': 'cross-site' };
    expect((await app.request('/admin/quote/rate-card', { headers })).status).toBe(200);
    expect((await app.request('/admin/quote/list', { headers })).status).toBe(200);
  });

  it('app-level wiring: createApp passes its allow-list into the mount', async () => {
    // Default ALLOWED_ORIGINS includes http://localhost:4173. A cross-site Origin must 403
    // regardless of auth; the allow-listed origin needs a real founder session to reach 200
    // now that quote:manage is enforced (no more dev keyless bypass).
    const app = createApp();
    const postWithOrigin = (origin?: string) => app.request('/admin/quote/estimate', {
      method: 'POST', body: estimateBody,
      headers: { 'content-type': 'application/json', cookie: founder, ...(origin ? { origin } : {}) },
    });
    expect((await postWithOrigin('https://evil.example')).status).toBe(403);
    expect((await postWithOrigin(OWN_ORIGIN)).status).toBe(200);
  });

  // ── Rate-lock: ops freeze-on-approval (spec 2026-07-11 §3) ──────────────────
  const patchAsRL = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const getAs = (email: string, app: App, path: string) =>
    app.request(path, { headers: { cookie: cookie(email) } });
  const saveDraft = async (app: App) =>
    (await post(app, '/admin/quote/save', { name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] })).json();

  it('a fresh draft carries no rate lock', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    const got = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(got.rateCardJson).toBeNull();
    expect(got.rateLockedUntil).toBeNull();
  });

  it('approving a quote (→ ready) freezes the current rate card with no expiry', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    const got = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(got.status).toBe('ready');
    expect(got.rateCardJson.version).toBe(RATE_CARD.version); // the whole card is snapshotted
    expect(got.rateCardJson.perKmCents).toEqual(RATE_CARD.perKmCents);
    expect(got.rateLockedUntil).toBeNull(); // ops lock = held until reopened, not time-boxed
  });

  it('reopening a ready quote to edit (→ draft) clears the lock', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'draft' });
    const got = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(got.status).toBe('draft');
    expect(got.rateCardJson).toBeNull();
    expect(got.rateLockedUntil).toBeNull();
  });

  it('sending a ready quote (→ sent) keeps the frozen snapshot', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'sent' });
    const got = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(got.status).toBe('sent');
    expect(got.rateCardJson.version).toBe(RATE_CARD.version); // lock survives the send
  });

  it('the locked snapshot (cost-bearing) is stripped for non-margin roles', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    const asFounder = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    const asFinance = await (await getAs('fin@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(asFounder.rateCardJson).not.toBeNull(); // margin:view keeps it
    expect(asFinance.rateCardJson).toBeUndefined(); // stripped — it embeds cost/markup
    expect(asFinance.rateLockedUntil).toBeNull(); // the (non-sensitive) expiry stays
  });

  // ── Rate-lock: GET /:id renders from the LOCKED card (Phase 3b) ─────────────
  it('GET /:id ships a locked estimate consistent with the approved total', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    const beforeApproval = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    const got = await (await getAs('f@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(got.estimate).toBeTruthy();
    // The shipped estimate matches the quote's own stored total — no live drift.
    expect(got.estimate.total.cents).toBe(got.totalCents);
    // Founder sees margin on the estimate; a draft is priced too (live card).
    expect(got.estimate.margin).toBeTruthy();
    expect(beforeApproval.estimate.total.cents).toBe(beforeApproval.totalCents);
  });

  it('the locked estimate omits margin for non-margin roles', async () => {
    const app = createApp();
    const q = await saveDraft(app);
    await patchAsRL('f@x.com', app, `/admin/quote/${q.id}`, { status: 'ready' });
    const asFinance = await (await getAs('fin@x.com', app, `/admin/quote/${q.id}`)).json();
    expect(asFinance.estimate).toBeTruthy();
    expect(asFinance.estimate.margin).toBeUndefined(); // shape() drops margin for non-margin:view
  });

  it('GET /:id prices a locked quote against its FROZEN snapshot, not the live card', async () => {
    // Seed a quote whose snapshot is a cheaper car rate (20¢/km) than the live card, locked with
    // no expiry (ops freeze). The estimate must re-price the stored engine request against THAT
    // snapshot — proving a rate-card change under the hood can't move an approved quote's price.
    const repo = new InMemoryQuoteRepo();
    const engine = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 200 }] };
    const frozen = { ...RATE_CARD, version: 'frozen-cheap', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } };
    const saved = await repo.save({
      product: 'private', vehicle: 'car', totalCents: 999999, currency: RATE_CARD.currency,
      rateCardVersion: 'frozen-cheap', request: { tool: {}, engine }, result: {},
      rateCardJson: frozen, rateLockedUntil: null,
    });
    const app = createApp({ quotes: repo });
    const got = await (await getAs('f@x.com', app, `/admin/quote/${saved.id}`)).json();
    expect(got.estimate.total.cents).toBe(4300); // 200km + 15km max buffer ×20¢ — the frozen car rate
  });

  it('degrades to estimate:null instead of 500 when a persisted lock field is malformed', async () => {
    // Defense-in-depth: pricing the LOCKED estimate must never 500 the quote-open path. A
    // corrupt/legacy lock value (here a non-Date rateLockedUntil) should yield estimate:null,
    // not a thrown 500 — the quote itself must still open.
    const repo = new InMemoryQuoteRepo();
    const engine = { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'A', to: 'B', distanceKm: 200 }] };
    const saved = await repo.save({
      product: 'private', vehicle: 'car', totalCents: 5000, currency: RATE_CARD.currency,
      rateCardVersion: 'v', request: { tool: {}, engine }, result: {},
      rateCardJson: RATE_CARD, rateLockedUntil: '2026-07-20T00:00:00Z' as unknown as Date,
    });
    const res = await getAs('f@x.com', createApp({ quotes: repo }), `/admin/quote/${saved.id}`);
    expect(res.status).toBe(200);
    expect((await res.json()).estimate).toBeNull();
  });
});

// ── Assignment + audit trail (spec 2026-07-16) ───────────────────────────────
// Notifications follow an explicit assignment, not a state transition, so `assignedTo` is the
// notification target and must never be inferable from who happened to move the quote last.
describe('quote assignment + audit trail', () => {
  const patchAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const postAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const getAs = (email: string, app: App, path: string) => app.request(path, { headers: { cookie: cookie(email) } });
  const draftAs = async (app: App, email: string) =>
    (await postAs(email, app, '/admin/quote/save', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();

  it('stamps createdBy/updatedBy on save and leaves the quote unassigned', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    const q = await (await getAs('f@x.com', app, `/admin/quote/${id}`)).json();
    expect(q.createdBy).toBe('op@x.com');
    expect(q.updatedBy).toBe('op@x.com');
    expect(q.assignedTo).toBeNull();
    expect(q.assignedAt).toBeNull();
  });

  it('assigns to an OPS_USERS member, stamping assignedAt + updatedBy but never createdBy', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    const res = await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    expect(res.status).toBe(200);
    const q = await res.json();
    expect(q.assignedTo).toBe('f@x.com');
    expect(q.assignedAt).not.toBeNull();
    expect(q.updatedBy).toBe('op@x.com');
    expect(q.createdBy).toBe('op@x.com');
  });

  // The hard requirement from the spec (§5): assignment drives an email, so an unvalidated
  // assignee would mail a stranger a link to a customer's quote.
  it('rejects an assignee outside OPS_USERS', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    const res = await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'stranger@evil.com' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('unknown_assignee');
  });

  it('accepts an assignee in any case (OPS_USERS lookup is lowercased) and stores it normalised', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    const q = await (await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'F@X.CoM' })).json();
    expect(q.assignedTo).toBe('f@x.com');
  });

  it('unassigns with null, clearing assignedAt', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    const q = await (await patchAs('f@x.com', app, `/admin/quote/${id}`, { assignedTo: null })).json();
    expect(q.assignedTo).toBeNull();
    expect(q.assignedAt).toBeNull();
  });

  it('leaves assignment untouched by a status-only patch', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    const q = await (await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'pending_review' })).json();
    expect(q.assignedTo).toBe('f@x.com'); // manual-only: transitions never re-assign
    expect(q.updatedBy).toBe('op@x.com');
  });

  // The queue's "Assigned to me" section filters on this, so the list projection must carry it.
  // (The projection is deliberately narrow — see postgresQuoteRepo.list — so it needs adding.)
  it('exposes assignedTo on the queue list', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    const list = await (await getAs('f@x.com', app, '/admin/quote/list')).json();
    expect(list.quotes.find((q: { id: string }) => q.id === id).assignedTo).toBe('f@x.com');
  });

  it('keeps createdBy immutable across a content re-save by someone else, moving updatedBy', async () => {
    const app = createApp();
    const { id } = await draftAs(app, 'op@x.com');
    await postAs('f@x.com', app, '/admin/quote/save', { id, vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 90 })] });
    const q = await (await getAs('f@x.com', app, `/admin/quote/${id}`)).json();
    expect(q.createdBy).toBe('op@x.com');
    expect(q.updatedBy).toBe('f@x.com');
  });
});

// ── Assignment notification (spec 2026-07-16 §6) ─────────────────────────────
// The point of the whole feature: assigning a quote is what tells someone it's theirs. Everything
// here guards a way that can go wrong — silence, spam, or a failed send taking the assign with it.
describe('quote assignment notification', () => {
  const OPS_BASE = 'https://ops.example.com';
  const patchAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const postAs = (email: string, app: App, path: string, body: unknown) =>
    app.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: cookie(email) }, body: JSON.stringify(body) });
  const draftAs = async (app: App, email: string) =>
    (await postAs(email, app, '/admin/quote/save', { name: 'Ana Silva', vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [leg({ distanceKm: 80 })] })).json();

  it('emails the assignee a deep link to that quote, naming who assigned it', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: OPS_BASE });
    const { id, reference } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    expect(mail.sent).toHaveLength(1);
    const msg = mail.sent[0];
    expect(msg.to).toBe('f@x.com');
    expect(msg.subject).toContain(reference);
    // The deep link is the entire value of the email — it must land on THIS quote, not the queue.
    expect(msg.html).toContain(`${OPS_BASE}/ops?quote=${id}`);
    expect(msg.text).toContain(`${OPS_BASE}/ops?quote=${id}`);
    expect(msg.html).toContain('op@x.com');
    expect(msg.html).toContain('Ana Silva');
  });

  it('does not email when you assign a quote to yourself', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: OPS_BASE });
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'op@x.com' });
    expect(mail.sent).toHaveLength(0);
  });

  it('does not email on unassign', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: OPS_BASE });
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    await patchAs('f@x.com', app, `/admin/quote/${id}`, { assignedTo: null });
    expect(mail.sent).toHaveLength(1); // the assign only — nobody is told they've been un-told
  });

  it('does not re-email when re-assigning to the same person', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: OPS_BASE });
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    expect(mail.sent).toHaveLength(1); // an unchanged assignment is not news
  });

  it('does not email on a status transition — assignment is the only trigger', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: OPS_BASE });
    const { id } = await draftAs(app, 'op@x.com');
    await patchAs('op@x.com', app, `/admin/quote/${id}`, { status: 'pending_review' });
    expect(mail.sent).toHaveLength(0);
  });

  it('still assigns when the mail provider is down (best-effort)', async () => {
    const app = createApp({
      email: { send: async () => { throw new Error('resend is down'); } },
      opsBaseUrl: OPS_BASE,
    });
    const { id } = await draftAs(app, 'op@x.com');
    const res = await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' });
    expect(res.status).toBe(200);
    expect((await res.json()).assignedTo).toBe('f@x.com'); // the assign is the durable bit
  });

  it('still assigns (and sends) when OPS_BASE_URL is unset — no link rather than no email', async () => {
    const mail = new FakeEmailAdapter();
    const app = createApp({ email: mail, opsBaseUrl: '' });
    const { id } = await draftAs(app, 'op@x.com');
    expect((await patchAs('op@x.com', app, `/admin/quote/${id}`, { assignedTo: 'f@x.com' })).status).toBe(200);
    expect(mail.sent).toHaveLength(1);
    expect(mail.sent[0].html).not.toContain('href="/ops');
  });
});
