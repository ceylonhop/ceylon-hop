// api/src/quote/simpleApproval.test.ts
// Task 1 of the ops self-approval plan (docs/superpowers/plans/2026-08-11-ops-self-approve-simple-transfers.md).
//
// Every fixture here is a REAL /save round-trip, read back out of the repo — never a hand-authored
// object. That is deliberate and load-bearing: the stored request is a { tool, engine } wrapper
// whose two halves name the same concepts differently (legs / vehicle / custom rate), so a
// hand-written fixture would encode whatever mistake the predicate makes and go green. The
// custom-$/km case below is the one that fails OPEN if the predicate reads the wrong half.
import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo, type SavedQuote } from '../db/quoteRepo';
import { InMemoryQuoteDiscountRepo } from '../db/quoteDiscountRepo';
import { signSession } from '../lib/opsAuth';
import { futureIsoDate } from '../testSupport/dates';
import { canOpsSelfApprove } from './simpleApproval';

const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;

/** Both repos share one store, exactly as app.ts composes them in production. */
function wired(deps: AppDeps = {}) {
  const discounts = new InMemoryQuoteDiscountRepo();
  const quotes = new InMemoryQuoteRepo(discounts);
  const app = createApp({
    auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret',
    quotes, quoteDiscounts: discounts, opsManualDiscountsEnabled: true, ...deps,
  });
  return { app, quotes, discounts };
}

const SINGLE_LEG = {
  name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, requestedService: 'private',
  legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 }],
};

/** POST /save, then read the row back — the fixture is whatever the route actually stored. */
async function saved(body: unknown, over: Partial<ReturnType<typeof wired>> = {}): Promise<SavedQuote> {
  const w = { ...wired(), ...over };
  const res = await w.app.request('/admin/quote/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: FOUNDER },
    body: JSON.stringify(body),
  });
  // 201 on insert, 200 on an update of an existing id.
  if (res.status !== 200 && res.status !== 201) throw new Error(`fixture save failed: ${res.status} ${await res.text()}`);
  const row = await w.quotes.get((await res.json()).id);
  if (!row) throw new Error('fixture save returned an id the repo does not have');
  return row;
}

describe('canOpsSelfApprove', () => {
  it('accepts a single-leg private transfer on a standard vehicle', async () => {
    expect(canOpsSelfApprove(await saved(SINGLE_LEG))).toBe(true);
  });

  it('accepts a single-leg transfer on van 14 (a standard tier, not a custom-priced one)', async () => {
    expect(canOpsSelfApprove(await saved({ ...SINGLE_LEG, vehicle: 'van_14' }))).toBe(true);
  });

  it('refuses a two-leg itinerary', async () => {
    const two = {
      ...SINGLE_LEG,
      legs: [
        { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 },
        { category: 'transfer', from: 'Kandy', to: 'Colombo', distanceKm: 115 },
      ],
    };
    expect(canOpsSelfApprove(await saved(two))).toBe(false);
  });

  it('refuses a chauffeur trip', async () => {
    const chauffeur = {
      ...SINGLE_LEG,
      requestedService: 'chauffeur',
      legs: [
        { category: 'transfer', from: 'Airport', to: 'Kandy', distanceKm: 120, date: futureIsoDate(30) },
        { category: 'stay_day', from: 'Kandy', to: '', date: futureIsoDate(31) },
        { category: 'transfer', from: 'Kandy', to: 'Ella', distanceKm: 140, date: futureIsoDate(32) },
      ],
    };
    const row = await saved(chauffeur);
    expect(row.product).toBe('chauffeur'); // guard: the fixture is the shape we think it is
    expect(canOpsSelfApprove(row)).toBe(false);
  });

  it('refuses the custom vehicle tier', async () => {
    expect(canOpsSelfApprove(await saved({ ...SINGLE_LEG, vehicle: 'custom' }))).toBe(false);
  });

  // THE FAIL-OPEN CASE. A predicate reading `engine.customRatePerKmCents` (the TOOL's field name)
  // gets undefined, concludes "no custom rate", and self-approves a hand-priced quote. The engine
  // half calls it `customPerKmCents`.
  it('refuses a hand-set $/km, whichever half of the stored request it is read from', async () => {
    const row = await saved({ ...SINGLE_LEG, vehicle: 'van_14', customRatePerKmCents: 250 });
    const engine = (row.request as { engine?: Record<string, unknown> }).engine;
    expect(engine?.customPerKmCents).toBe(250); // guard: the rate really did reach the stored row
    expect(canOpsSelfApprove(row)).toBe(false);
  });

  it('refuses a quote carrying an active discount', async () => {
    const w = wired();
    const row = await saved(SINGLE_LEG, w);
    expect(canOpsSelfApprove(row)).toBe(true); // qualifies before the discount

    const res = await w.app.request('/admin/quote/save', {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: FOUNDER },
      body: JSON.stringify({ ...SINGLE_LEG, id: row.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } }),
    });
    expect(res.status).toBe(200);
    const discounted = await w.quotes.get(row.id);
    expect(canOpsSelfApprove(discounted!)).toBe(false);
  });

  // Task 3 computes this flag for every row in the queue, so an unrecognised shape must return
  // false, never throw — a throw here is a broken queue, not a denied approval.
  it('refuses an unpriced draft shell without throwing', async () => {
    const w = wired();
    const res = await w.app.request('/admin/quote/draft', {
      method: 'POST', headers: { 'content-type': 'application/json', cookie: FOUNDER },
    });
    expect(res.status).toBe(201);
    const shell = await w.quotes.get((await res.json()).id);
    expect(canOpsSelfApprove(shell!)).toBe(false);
  });

  it('refuses a row whose stored request has no engine half', async () => {
    const row = { ...(await saved(SINGLE_LEG)), request: { tool: { legs: [{}] } } };
    expect(canOpsSelfApprove(row)).toBe(false);
  });

  it('refuses malformed and absent requests without throwing', async () => {
    const base = await saved(SINGLE_LEG);
    for (const request of [null, undefined, 'nonsense', 42, {}, { engine: null }, { engine: {} }]) {
      expect(canOpsSelfApprove({ ...base, request })).toBe(false);
    }
  });
});

// Owner decision D3 (2026-10-12): a quote carrying a frozen chauffeur alternative has TWO prices
// to approve, so it is founder-only. One driving leg + a stay day on another date is the smallest
// itinerary that is both self-approvable today AND has a feasible chauffeur alternative.
describe('canOpsSelfApprove — a quote with a chauffeur alternative', () => {
  // `service: 'private'` is what the builder sends for a point-to-point price; without it a stay day
  // makes toEngineRequest derive a chauffeur quote.
  const ONE_DRIVE_PLUS_STAY = {
    ...SINGLE_LEG,
    service: 'private',
    legs: [
      { category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115, date: futureIsoDate(30) },
      { category: 'stay_day', from: 'Kandy', to: '', date: futureIsoDate(31) },
    ],
  };

  it('refuses a "both" quote that froze an alternative', async () => {
    const row = await saved({ ...ONE_DRIVE_PLUS_STAY, requestedService: 'both' });
    expect((row.result as { alt?: unknown }).alt).toBeDefined(); // guard: /save really froze one
    expect(canOpsSelfApprove(row)).toBe(false);
  });

  it('still accepts the same itinerary asked for as private only (control)', async () => {
    const row = await saved({ ...ONE_DRIVE_PLUS_STAY, requestedService: 'private' });
    expect((row.result as { alt?: unknown }).alt).toBeUndefined();
    expect(canOpsSelfApprove(row)).toBe(true);
  });

  // The predicate tests the RAW key (`!= null`), not alternativeOf(): a malformed alt must still
  // block. Only null/undefined mean "no alternative" — so 0, false and '' also block (they are
  // not null). A refactor to alternativeOf(quote) != null would let all of these through.
  it.each([
    ['{}', {}], ["'x'", 'x'], ['0', 0], ['false', false], ["''", ''], ['[]', []], ['a bare product', { product: 'chauffeur' }],
  ])('a malformed alt (%s) still blocks self-approval', async (_l, alt) => {
    const row = await saved({ ...ONE_DRIVE_PLUS_STAY, requestedService: 'private' });
    expect(canOpsSelfApprove(row)).toBe(true); // guard: nothing else blocks it
    expect(canOpsSelfApprove({ ...row, result: { ...(row.result as object), alt } })).toBe(false);
  });

  it('treats alt: null as no alternative', async () => {
    const row = await saved({ ...ONE_DRIVE_PLUS_STAY, requestedService: 'private' });
    expect(canOpsSelfApprove({ ...row, result: { ...(row.result as object), alt: null } })).toBe(true);
  });
});
