import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { InMemoryExperienceRepo } from '../db/experienceRepo';
import { InMemoryExperienceInterestRepo } from '../db/experienceInterestRepo';
import { signQuoteViewToken } from '../lib/bookingToken';
import { PLACEHOLDERS } from '../experiences/placeholders';

// The customer quote page shows NO partner experiences (owner, 2026-10-15: "it's a distraction").
// They moved to the pay-link confirmation, after the customer has paid (quotePay.experiences.test.ts).
// Interests already recorded on quotes keep flowing onto bookings (quoteInterestLinking.test.ts).
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

async function setup(now?: () => number) {
  const quotes = new InMemoryQuoteRepo();
  const experiences = new InMemoryExperienceRepo();
  const [massage] = await Promise.all(PLACEHOLDERS.map((p) => experiences.create(p)));
  const experienceInterests = new InMemoryExperienceInterestRepo({ quotes, experiences });
  const app = createApp({ quotes, experiences, experienceInterests, bookingLinkSecret: SECRET, ...(now ? { now } : {}) });
  const saved = await quotes.save(quoteInput() as never);
  const quote = (await quotes.patch(saved.id, { status: 'ready' }))!;
  const token = signQuoteViewToken(quote.id, SECRET);
  const get = () => app.request(`/quote-view?t=${encodeURIComponent(token)}`);
  const post = (body: unknown) => app.request('/quote-view/interest', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  return { app, quotes, experienceInterests, quote, token, get, post, massage: massage! };
}

describe('GET /quote-view — no partner experiences', () => {
  it('a live quote at Sigiriya (where experiences ARE matched) carries no experiences', async () => {
    const t = await setup();
    const body = await (await t.get()).json();
    expect(body.state).toBe('live');
    expect(body.view.heroTotalUsd).toBe('$114.50');
    expect(body).not.toHaveProperty('experiences');
  });

  it('nor does a lapsed one', async () => {
    const t = await setup(() => Date.parse('2026-08-20T00:00:00Z'));
    await t.quotes.patch(t.quote.id, { offerValidUntil: new Date('2026-08-01T00:00:00Z') });
    const body = await (await t.get()).json();
    expect(body.state).toBe('lapsed');
    expect(body).not.toHaveProperty('experiences');
  });
});

describe('POST /quote-view/interest — retired', () => {
  // A quote page cached from before the change may still post here: it gets a clean 410 and the
  // page's own "Couldn't save" line, and nothing is recorded.
  it('answers 410 gone for a valid body and records nothing', async () => {
    const t = await setup();
    const res = await t.post({ t: t.token, experienceId: t.massage.id, interested: true });
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'gone' });
    expect(await t.experienceInterests.listForQuote(t.quote.id)).toEqual([]);
  });

  it('answers 410 for anything else too', async () => {
    const t = await setup();
    expect((await t.post({})).status).toBe(410);
    const raw = await t.app.request('/quote-view/interest', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(raw.status).toBe(410);
  });
});
