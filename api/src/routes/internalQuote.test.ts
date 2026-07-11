import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { internalQuoteRoutes } from './internalQuote';
import { FakeMapsAdapter } from '../adapters/maps';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signSession } from '../lib/opsAuth';

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

  it('estimate prices a private leg from a manual km (80km car = 3542¢); no drafts; lineItems carry cents', async () => {
    const res = await post(createApp(), '/admin/quote/estimate', {
      name: 'Test', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })],
    });
    expect(res.status).toBe(200);
    const d = await res.json();
    expect(d.total.cents).toBe(3542);
    expect(d.amountDueNow.cents).toBe(3542); // private → full
    expect(d.drafts).toBeUndefined(); // V15: dead drafts removed
    expect(Number.isInteger(d.lineItems[0].amountCents)).toBe(true); // Fix 7: cents on line items
    expect(d.lineItems[0].meta.billableKm).toBe(88); // meta passthrough — client zips travel items with legs
    expect(d.comparison).toBeUndefined(); // reflow: car/van comparison removed
    // reflow: services chooser replaces comparison. Single undated leg → chauffeur infeasible.
    expect(d.services.pointToPoint.total.cents).toBe(3542);
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
    const bodyReq = { name: 'Maya', contact: '+34600', vehicle: 'car', passengerCount: 2, luggageCount: 2, legs: [leg({ distanceKm: 80 })] };
    const est = await (await post(app, '/admin/quote/estimate', bodyReq)).json();
    const res = await post(app, '/admin/quote/save', bodyReq);
    expect(res.status).toBe(201);
    const saved = await res.json();
    expect(saved.reference).toMatch(/^Q-[A-HJ-NP-Z2-9]{5}$/); // 5 chars, unambiguous alphabet (no 0/O/1/I)
    expect(saved.status).toBe('draft');
    const got = await (await authedGet(app, `/admin/quote/${saved.id}`)).json();
    expect(got.totalCents).toBe(est.total.cents); // saved total == previewed total
    expect(got.customerName).toBe('Maya');
    expect(got.rateCardVersion).toBe('2026-07-11');
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
    expect(got.totalCents).toBe(3542); // engine price, not the bogus client total
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

  it('accepts an injected QuoteRepo without breaking existing routes', async () => {
    const app = createApp({ quotes: new InMemoryQuoteRepo() });
    const res = await authedGet(app, '/admin/quote/places?q=kand');
    expect((await res.json()).places).toEqual(['Kandy']);
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
    expect(d.total.cents).toBe(8324); // van 140km
  });

  it('sightseeing/waiting/safari-wait toggles add engine extras on a private trip', async () => {
    const base = await (await post(createApp(), '/admin/quote/estimate', { vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80 }] })).json();
    const withFees = await (await post(createApp(), '/admin/quote/estimate', { service: 'private', vehicle: 'car', passengerCount: 1, luggageCount: 0, legs: [{ category: 'transfer', from: 'A', to: 'B', distanceKm: 80, addSightseeingFee: true, addWaitingFee: true, addSafariWait: true }] })).json();
    expect(withFees.total.cents).toBe(base.total.cents + 1000 + 1000 + 1900); // sightseeing $10 + waiting $10 + safari-wait $19
  });

  it('van_9/van_14/custom are no longer gated — they price correctly (200, total > 0)', async () => {
    const cases: Array<{ vehicle: string; pax: number; expectedCents: number }> = [
      { vehicle: 'van_9',  pax: 8,  expectedCents: 8324 }, // 154 billableKm × 54.05¢ = 8324 (> floor 5000)
      { vehicle: 'van_14', pax: 12, expectedCents: 8501 }, // round(154 × 55.2) = 8501 > floor 8500
      { vehicle: 'custom', pax: 20, expectedCents: 30993 }, // 154 × 201.25¢ = 30993
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
    expect(d.version).toBe('2026-07-11');
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
    expect((await res.json()).total.cents).toBe(3542);
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
    expect(j.total.cents).toBe(154 * 90); // billable 154km × 90¢, not the 48¢ placeholder
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
});
