import { describe, it, expect } from 'vitest';
import { createApp, type AppDeps } from '../app';
import { InMemoryRateRevisionRepo } from '../db/rateRevisionRepo';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { ratesFromCard } from '../quote/rateRevision';
import { RATE_CARD } from '../quote/rateCard';
import { signSession } from '../lib/opsAuth';

// Spec 2026-09-26 §8.3: once the founder saves a revision, every server price reads it. Each case
// saves one revision straight into the repo (the API that does this in production is opsRates.ts)
// and checks one call site against the same request with no revision.
const AUTH = { opsUsers: 'f@x.com:founder', googleClientId: 'cid', opsSessionSecret: 'sek' };
const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;
const app = (deps: AppDeps = {}) => createApp({ auth: AUTH, adminApiKey: 'k', ...deps });
const post = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'POST', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body) });
const patch = (a: ReturnType<typeof app>, path: string, body: unknown) =>
  a.request(path, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: FOUNDER }, body: JSON.stringify(body) });
const get = (a: ReturnType<typeof app>, path: string) => a.request(path, { headers: { cookie: FOUNDER } });

const TRIP = { service: 'private', vehicle: 'car', passengerCount: 2, luggageCount: 1, requestedService: 'private', legs: [{ category: 'transfer', from: 'Kandy', to: 'Galle', distanceKm: 200 }] };
const CUSTOMER = { firstName: 'Maya', lastName: 'Silva', email: 'maya@example.com', whatsapp: '+34600000000', country: 'Spain' };

async function withRevision(patchRates: Partial<ReturnType<typeof ratesFromCard>>) {
  const revisions = new InMemoryRateRevisionRepo();
  const rev = await revisions.create({ rates: { ...ratesFromCard(RATE_CARD), ...patchRates }, baseVersion: null, createdBy: 'f@x.com' });
  return { revisions, rev };
}
const doubleCar = () => ({ perKmCents: { ...ratesFromCard(RATE_CARD).perKmCents, car: 80.5 } });

describe('a saved revision reaches every server price', () => {
  it('ops estimate: the new per-km price, and LKR at the revision\'s FX', async () => {
    const before = await (await post(app(), '/admin/quote/estimate', TRIP)).json();
    const { revisions } = await withRevision({ ...doubleCar(), fxUsdToLkr: 300 });
    const after = await (await post(app({ rateRevisions: revisions }), '/admin/quote/estimate', TRIP)).json();
    expect(after.total.cents).toBeGreaterThan(before.total.cents);
    expect(after.fxUsdToLkr).toBe(300);
    expect(after.total.lkrAmount).toBe(Math.round((after.total.cents * 300) / 100));
  });

  it('ops save stamps the revision\'s version, and approval freezes it against a later revision', async () => {
    const { revisions, rev } = await withRevision(doubleCar());
    const quotes = new InMemoryQuoteRepo();
    const a = app({ rateRevisions: revisions, quotes });
    const saved = await (await post(a, '/admin/quote/save', TRIP)).json();
    expect((await quotes.get(saved.id))!.rateCardVersion).toBe(rev.version);
    await patch(a, `/admin/quote/${saved.id}`, { status: 'pending_review' });
    await patch(a, `/admin/quote/${saved.id}`, { status: 'ready' });
    const approvedTotal = (await quotes.get(saved.id))!.totalCents;
    await revisions.create({ rates: { ...ratesFromCard(RATE_CARD), perKmCents: { ...ratesFromCard(RATE_CARD).perKmCents, car: 200 } }, baseVersion: rev.version, createdBy: 'f@x.com' });
    const reopened = await (await get(a, `/admin/quote/${saved.id}`)).json();
    expect(reopened.estimate.total.cents).toBe(approvedTotal); // the lock holds
  });

  it('reopening a draft prices it on the live card, not the code card', async () => {
    const quotes = new InMemoryQuoteRepo();
    const { revisions } = await withRevision(doubleCar());
    const a = app({ rateRevisions: revisions, quotes });
    const saved = await (await post(a, '/admin/quote/save', TRIP)).json();
    const reopened = await (await get(a, `/admin/quote/${saved.id}`)).json();
    const live = await (await post(a, '/admin/quote/estimate', TRIP)).json();
    expect(reopened.estimate.total.cents).toBe(live.total.cents);
  });

  it('the builder\'s rate card read shows the revision', async () => {
    const { revisions, rev } = await withRevision(doubleCar());
    const card = await (await get(app({ rateRevisions: revisions }), '/admin/quote/rate-card')).json();
    expect(card).toMatchObject({ version: rev.version, perKmCents: { car: 80.5 } });
    expect(card).not.toHaveProperty('costPerKmCents');
  });

  it('website estimate: POST /quote/v2/estimate (what route pages, search and booking call) prices on the revision', async () => {
    const V2_PRIVATE = { product: 'private', routeId: 'kandy-ella', vehicle: 'car', pax: 2, bags: 2, legs: [{ from: 'Kandy', to: 'Ella' }], extras: [] };
    const send = (a: ReturnType<typeof app>) => a.request('/quote/v2/estimate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(V2_PRIVATE) });
    const before = await (await send(app({ quoteV2Enabled: true }))).json();
    const { revisions } = await withRevision(doubleCar());
    const after = await (await send(app({ quoteV2Enabled: true, rateRevisions: revisions }))).json();
    expect(after.totalCents).toBeGreaterThan(before.totalCents);
  });

  it('checkout: a website booking is charged at the revision', async () => {
    const booking = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer: CUSTOMER };
    const send = (a: ReturnType<typeof app>) => a.request('/bookings/single', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(booking) });
    expect((await (await send(app())).json()).total).toBe(7800); // today's card (bookings.test.ts pins the same)
    const { revisions } = await withRevision(doubleCar());
    expect((await (await send(app({ rateRevisions: revisions }))).json()).total).toBeGreaterThan(7800);
  });

  it('a web quote still inside its 7-day lock keeps its price through a revision (story 9)', async () => {
    const quotes = new InMemoryQuoteRepo();
    const saved = await quotes.save({
      channel: 'web', product: 'private', totalCents: 0, currency: 'USD', rateCardVersion: 'frozen', request: {}, result: {},
      rateCardJson: { ...RATE_CARD, version: 'frozen', perKmCents: { ...RATE_CARD.perKmCents, car: 20 } },
      rateLockedUntil: new Date(Date.now() + 3 * 86_400_000),
    });
    const { revisions } = await withRevision(doubleCar());
    const booking = { from: 'Colombo Airport (CMB)', to: 'Galle', vehicleType: 'car', adults: 2, children: 0, bags: 2, quoteId: saved.id, customer: CUSTOMER };
    const res = await app({ quotes, rateRevisions: revisions }).request('/bookings/single', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(booking) });
    expect((await res.json()).total).toBe(3900); // the frozen 20¢/km card, as bookings.test.ts pins — not the revision
  });
});
