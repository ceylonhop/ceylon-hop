// api/src/routes/internalQuoteDiscount.test.ts
// Task 5 — the Ops discount API. Kept out of internalQuote.test.ts, which is already large and
// whose helpers all assume a founder session; several cases here need the other roles.
import { describe, it, expect } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { signSession } from '../lib/opsAuth';
import { InMemoryQuoteDiscountRepo } from '../db/quoteDiscountRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';

const AUTH = { opsUsers: 'f@x.com:founder,fin@x.com:finance,op@x.com:ops', googleClientId: 'cid', opsSessionSecret: 'sek' };
const cookie = (email: string) => `ch_ops=${signSession({ email, exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const FOUNDER = cookie('f@x.com');
const OPS = cookie('op@x.com');
const FINANCE = cookie('fin@x.com');

function app(deps: AppDeps = {}) {
  return realCreateApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: 'test-link-secret', ...deps });
}
/** Both repos share one store, exactly as app.ts composes them in production. */
function wired(enabled = true) {
  const discounts = new InMemoryQuoteDiscountRepo();
  const quotes = new InMemoryQuoteRepo(discounts);
  return { discounts, quotes, a: app({ quotes, quoteDiscounts: discounts, opsManualDiscountsEnabled: enabled }) };
}

const BODY = {
  name: 'Maya', vehicle: 'car', passengerCount: 2, luggageCount: 2, requestedService: 'private',
  legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 115 }],
};

function save(a: ReturnType<typeof app>, body: unknown, jar = FOUNDER) {
  return a.request('/admin/quote/save', {
    method: 'POST',
    headers: { 'content-type': 'application/json', cookie: jar },
    body: JSON.stringify(body),
  });
}

async function seed(a: ReturnType<typeof app>) {
  const res = await save(a, BODY);
  if (res.status >= 400) throw new Error(`seed failed ${res.status}: ${await res.text()}`);
  return (await res.json()) as { id: string; totalCents: number };
}

describe('Ops discount API', () => {
  it('applies a founder discount and records the money either side', async () => {
    const { discounts, a } = wired();
    const q = await seed(a);
    const res = await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } });
    expect(res.status).toBe(200);

    const row = await discounts.activeFor(q.id);
    expect(row?.appliedCents).toBe(1000);
    expect(row?.reason).toBe('closing');
    expect(row?.appliedBy).toBe('f@x.com');
    expect(row?.totalBeforeCents).toBe(q.totalCents);
    // The stored after-total is what the engine produced, not before − applied: finishing runs
    // after the discount, so those differ.
    expect(row?.totalAfterCents).toBe(((await res.json()) as { totalCents: number }).totalCents);
  });

  it('refuses ops and finance — only a founder may give money away', async () => {
    for (const jar of [OPS, FINANCE]) {
      const { discounts, a } = wired();
      const q = await seed(a);
      const res = await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'x' } }, jar);
      expect(res.status).toBe(403);
      expect(await discounts.activeFor(q.id)).toBeNull();
    }
  });

  it('refuses everyone while the rollout flag is off', async () => {
    const { discounts, a } = wired(false);
    const q = await seed(a);
    const res = await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'x' } });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'discounts_disabled' });
    expect(await discounts.activeFor(q.id)).toBeNull();
  });

  it('PRESERVES the discount through an ordinary content save', async () => {
    const { discounts, a } = wired();
    const q = await seed(a);
    const discounted = (await (await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } })).json()) as { totalCents: number };
    // NOT q.totalCents - 1000: finishing runs AFTER the discount, so the discounted total carries
    // its own adjustment. That is exactly why total_after_cents is stored rather than derived.
    expect(discounted.totalCents).toBeLessThan(q.totalCents);

    // An autosave with no discount field must not silently restore the undiscounted price.
    const res = await save(a, { ...BODY, id: q.id, notes: 'called them' });
    const body = (await res.json()) as { totalCents: number };
    expect((await discounts.activeFor(q.id))?.appliedCents).toBe(1000);
    expect(body.totalCents).toBe(discounted.totalCents);
  });

  it('removes on explicit null, and the price returns to full', async () => {
    const { discounts, a } = wired();
    const q = await seed(a);
    await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } });
    const res = await save(a, { ...BODY, id: q.id, discount: null });

    expect(((await res.json()) as { totalCents: number }).totalCents).toBe(q.totalCents);
    expect(await discounts.activeFor(q.id)).toBeNull();
    const history = await discounts.historyFor(q.id);
    expect(history[0].status).toBe('removed');
    expect(history[0].supersededBy).toBe('f@x.com');
  });

  it('caps a greedy percentage at 30% rather than refusing it', async () => {
    const { discounts, a } = wired();
    const q = await seed(a);
    await save(a, { ...BODY, id: q.id, discount: { method: 'percentage', basisPoints: 9000, reason: 'greedy' } });
    const row = await discounts.activeFor(q.id);
    expect(row?.capReason).toBe('percentage_cap');
    expect(row!.appliedCents).toBeLessThan(row!.requestedCents);
  });

  it('rejects a discount with no reason', async () => {
    const { a } = wired();
    const q = await seed(a);
    const res = await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: '  ' } });
    expect(res.status).toBe(400);
  });
});

describe('Discount history endpoint', () => {
  const get = (a: ReturnType<typeof app>, path: string, jar: string) =>
    a.request(path, { headers: { cookie: jar } });

  it('shows a founder the cost and margin', async () => {
    const { a } = wired();
    const q = await seed(a);
    await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } });
    const body = (await (await get(a, `/admin/quote/${q.id}/discounts`, FOUNDER)).json()) as { discounts: Record<string, unknown>[] };

    expect(body.discounts).toHaveLength(1);
    expect(body.discounts[0]).toMatchObject({ appliedCents: 1000, reason: 'closing', appliedBy: 'f@x.com' });
    expect(body.discounts[0]).toHaveProperty('marginAfterCents');
  });

  it('STRIPS cost, margin and cap reason for ops', async () => {
    const { a } = wired();
    const q = await seed(a);
    await save(a, { ...BODY, id: q.id, discount: { method: 'fixed', amountCents: 1000, reason: 'closing' } });
    const body = (await (await get(a, `/admin/quote/${q.id}/discounts`, OPS)).json()) as { discounts: Record<string, unknown>[] };

    // Ops still sees THAT it was discounted and by how much — just never what it cost us.
    expect(body.discounts[0]).toMatchObject({ appliedCents: 1000, reason: 'closing' });
    expect(body.discounts[0]).not.toHaveProperty('marginAfterCents');
    expect(body.discounts[0]).not.toHaveProperty('estimatedCostCents');
    expect(body.discounts[0]).not.toHaveProperty('capReason');
  });
});
