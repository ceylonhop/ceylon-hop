import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { signQuoteViewToken } from '../lib/bookingToken';
import { PLACEHOLDERS } from '../experiences/placeholders';
import type { Experience } from '../experiences/experience';

// Partner experiences on the quote page (spec 2026-10-06 D9/D12/D17).
const SECRET = 'test-link-secret';

const legs = [
  { from: 'Colombo Airport (CMB)', to: 'Sigiriya / Dambulla', date: '2026-08-20', distanceKm: 168 },
  { from: 'Sigiriya / Dambulla', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
];
const quoteInput = () => ({
  channel: 'ops' as const, product: 'private', customerName: 'Anna Bergström', customerContact: 'anna@example.com',
  vehicle: 'car', currency: 'USD', totalCents: 11_450, marginCents: 1_700, requestedService: 'private',
  request: {
    engine: { product: 'private', vehicle: 'car', pax: 2, bags: 2, legs: legs.map(({ from, to, distanceKm }) => ({ from, to, distanceKm })) },
    tool: { passengerCount: 2, luggageCount: 2, vehicle: 'car', legs },
  },
  result: { totalCents: 11_450, marginEstimateCents: 1_700, lineItems: [] },
});

async function setup() {
  const quotes = new InMemoryQuoteRepo();
  const experiences = new InMemoryExperienceRepo();
  const [massage, cooking] = await Promise.all(PLACEHOLDERS.map((p) => experiences.create(p)));
  const far = await experiences.create({ ...PLACEHOLDERS[0], slug: 'far-away', name: 'Whale watching', lat: 5.95, lng: 80.46, radiusKm: 5 });
  const experienceInterests = new InMemoryExperienceInterestRepo({ quotes, experiences });
  const app = createApp({ quotes, experiences, experienceInterests, bookingLinkSecret: SECRET });
  const saved = await quotes.save(quoteInput() as never);
  const quote = (await quotes.patch(saved.id, { status: 'ready' }))!;
  const token = signQuoteViewToken(quote.id, SECRET);
  const get = (t = token) => app.request(`/quote-view?t=${encodeURIComponent(t)}`);
  const post = (body: unknown) => app.request('/quote-view/interest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, quotes, experiences, experienceInterests, quote, token, get, post, massage: massage!, cooking: cooking!, far: far! };
}

afterEach(() => vi.restoreAllMocks());

describe('GET /quote-view experiences', () => {
  it('lists the experiences near the quote’s stops, public fields only, with interested flags', async () => {
    const t = await setup();
    await t.experienceInterests.record({ experience: t.massage as Experience, source: 'quote_page', quoteId: t.quote.id });
    const body = await (await t.get()).json();
    expect(body.state).toBe('live');
    expect(body.experiences).toHaveLength(1);
    expect(body.experiences[0].place).toBe('Sigiriya');
    const items = body.experiences[0].items;
    expect(items.map((i: { name: string }) => i.name).sort()).toEqual(['Ayurvedic massage', 'Elephant jeep safari', 'Village cooking lesson']);
    const m = items.find((i: { id: string }) => i.id === t.massage.id);
    expect(m.interested).toBe(true);
    expect(m.aboutKm).toEqual(expect.any(Number));
    expect(items.find((i: { id: string }) => i.id === t.cooking.id).interested).toBe(false);
    const s = JSON.stringify(body.experiences);
    expect(s).not.toMatch(/partnerContact|"lat"|"lng"|radiusKm|createdBy|updatedBy|"active"/);
  });

  it('also serves a lapsed quote', async () => {
    const t = await setup();
    await t.quotes.patch(t.quote.id, { offerValidUntil: new Date('2026-08-01T00:00:00Z') });
    const app2 = createApp({
      quotes: t.quotes, experiences: t.experiences, experienceInterests: t.experienceInterests,
      bookingLinkSecret: SECRET, now: () => Date.parse('2026-08-20T00:00:00Z'),
    });
    const body = await (await app2.request(`/quote-view?t=${t.token}`)).json();
    expect(body.state).toBe('lapsed');
    expect(body.experiences[0].items.length).toBeGreaterThan(0);
  });

  it('a matcher failure degrades to experiences: [] and the quote still renders', async () => {
    const t = await setup();
    vi.spyOn(t.experiences, 'listActive').mockRejectedValue(new Error('db down'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const res = await t.get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.state).toBe('live');
    expect(body.view.heroTotalUsd).toBe('$114.50');
    expect(body.experiences).toEqual([]);
  });

  it('carries no experiences for booked or unavailable quotes', async () => {
    const t = await setup();
    await t.quotes.patch(t.quote.id, { status: 'won' });
    expect('experiences' in await (await t.get()).json()).toBe(false);
    await t.quotes.patch(t.quote.id, { status: 'draft' });
    expect('experiences' in await (await t.get()).json()).toBe(false);
  });
});

describe('POST /quote-view/interest', () => {
  let t: Awaited<ReturnType<typeof setup>>;
  beforeEach(async () => { t = await setup(); });

  it('records the interest (source quote_page) and answers {interested:true}; a double tap is one row', async () => {
    const body = { t: t.token, experienceId: t.massage.id, interested: true };
    for (let i = 0; i < 2; i++) {
      const res = await t.post(body);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ interested: true });
    }
    const rows = await t.experienceInterests.listForQuote(t.quote.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ experienceId: t.massage.id, source: 'quote_page', status: 'new', nameSnapshot: 'Ayurvedic massage' });
  });

  it('withdraws while the lead is still new, and withdrawing twice is fine', async () => {
    await t.post({ t: t.token, experienceId: t.massage.id, interested: true });
    for (let i = 0; i < 2; i++) {
      const res = await t.post({ t: t.token, experienceId: t.massage.id, interested: false });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ interested: false });
    }
    expect(await t.experienceInterests.listForQuote(t.quote.id)).toEqual([]);
  });

  it('once ops has contacted the customer the interest stays: 200 {interested:true}', async () => {
    const row = await t.experienceInterests.record({ experience: t.massage as Experience, source: 'quote_page', quoteId: t.quote.id });
    await t.experienceInterests.patch(row.id, { status: 'contacted', updatedBy: 'ops@ceylonhop.com' });
    const res = await t.post({ t: t.token, experienceId: t.massage.id, interested: false });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ interested: true });
    expect(await t.experienceInterests.listForQuote(t.quote.id)).toHaveLength(1);
  });

  // /quotes/pay/start creates the booking but leaves the quote `sent` until the payment settles.
  // A tick made in that window must follow the quote into the booking too — otherwise it stays
  // quote-only, the quote flips to `won`, and the lead silently drops out of the ops queue.
  it('a tap after the quote already has a booking is linked to that booking', async () => {
    const bookingId = '0b0f6a4e-1c2d-4e5f-8a9b-0c1d2e3f4a5b';
    await t.quotes.patch(t.quote.id, { convertedBookingId: bookingId });
    const res = await t.post({ t: t.token, experienceId: t.massage.id, interested: true });
    expect(res.status).toBe(200);
    const rows = await t.experienceInterests.listForBooking(bookingId);
    expect(rows.map((r) => r.experienceId)).toEqual([t.massage.id]);
  });

  it('accepts a tap on a lapsed quote (spec D12)', async () => {
    await t.quotes.patch(t.quote.id, { offerValidUntil: new Date('2026-08-01T00:00:00Z') });
    const res = await t.post({ t: t.token, experienceId: t.massage.id, interested: true });
    expect(res.status).toBe(200);
  });

  it('409 quote_unavailable for a bad token, a draft, a booked and a deleted quote', async () => {
    const send = (token: string) => t.post({ t: token, experienceId: t.massage.id, interested: true });
    const bad = await send('nonsense');
    expect(bad.status).toBe(409);
    expect(await bad.json()).toEqual({ error: 'quote_unavailable' });
    for (const status of ['draft', 'won', 'lost'] as const) {
      await t.quotes.patch(t.quote.id, { status });
      expect((await send(t.token)).status).toBe(409);
    }
    await t.quotes.patch(t.quote.id, { status: 'ready' });
    await t.quotes.softDelete(t.quote.id, 'ops@ceylonhop.com');
    const gone = await send(t.token);
    expect(gone.status).toBe(409);
    expect(await gone.json()).toEqual({ error: 'quote_unavailable' });
    expect(await t.experienceInterests.listForQuote(t.quote.id)).toEqual([]);
  });

  it('422 not_offered for an experience that is not among this quote’s matches', async () => {
    const ok = await t.experiences.create({ ...PLACEHOLDERS[0], slug: 'retired', active: false });
    for (const id of [t.far.id, ok.id, '3f1c2d4e-0000-4000-8000-000000000000']) {
      const res = await t.post({ t: t.token, experienceId: id, interested: true });
      expect(res.status).toBe(422);
      expect(await res.json()).toEqual({ error: 'not_offered' });
    }
    expect(await t.experienceInterests.listForQuote(t.quote.id)).toEqual([]);
  });

  it('400 for a malformed or over-long body', async () => {
    const good = { t: t.token, experienceId: t.massage.id, interested: true };
    for (const bad of [{}, { ...good, interested: 'yes' }, { ...good, experienceId: 'nope' }, { ...good, extra: 1 }, { ...good, t: undefined }]) {
      expect((await t.post(bad)).status).toBe(400);
    }
    const raw = await t.app.request('/quote-view/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(400);
  });

  it('rate-limits the POST but never the GET', async () => {
    const quotes = new InMemoryQuoteRepo();
    const app = createApp({ quotes, bookingLinkSecret: SECRET, rateLimit: { max: 2, windowMs: 60_000 } });
    const bad = () => app.request('/quote-view/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
    for (let i = 0; i < 5; i++) expect((await app.request('/quote-view?t=x')).status).toBe(200);
  });
});
