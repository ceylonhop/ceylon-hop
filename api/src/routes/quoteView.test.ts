import { describe, it, expect, beforeEach } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signQuoteViewToken, signQuotePayToken } from '../lib/bookingToken';

const SECRET = 'test-link-secret';

// A ready, priced, two-leg private ops quote — the shape every assertion below builds on.
// totalCents (11450 = $114.50) is not an arbitrary placeholder: it is what quote/engine.ts's
// quote() actually returns for these two legs against the live RATE_CARD (verified by running
// it directly) — because /quote-view recomputes the priced service against the locked card
// (see servicesFor in quoteView.ts, mirroring internalQuote.ts's serviceChooserData), a fixture
// total that merely LOOKED plausible but didn't match the engine's real output would make the
// route's honest recompute look like a bug.
function quoteInput() {
  return {
    channel: 'ops' as const,
    product: 'private',
    customerName: 'Anna Bergström',
    customerContact: 'anna@example.com',
    vehicle: 'car',
    currency: 'USD',
    totalCents: 11_450,
    marginCents: 1_700,
    requestedService: 'private',
    request: {
      engine: {
        product: 'private', vehicle: 'car', pax: 2, bags: 2,
        legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', distanceKm: 168 },
          { from: 'Sigiriya', to: 'Kandy', distanceKm: 92 },
        ],
      },
      tool: {
        passengerCount: 2, luggageCount: 2, vehicle: 'car',
        legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 168 },
          { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 92 },
        ],
      },
    },
    result: { totalCents: 11_450, marginEstimateCents: 1_700, lineItems: [] },
  };
}

describe('GET /quote-view', () => {
  let quotes: InMemoryQuoteRepo;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    quotes = new InMemoryQuoteRepo();
    app = createApp({ quotes, bookingLinkSecret: SECRET });
  });

  async function readyQuote(over: Record<string, unknown> = {}) {
    const saved = await quotes.save(quoteInput() as never);
    return (await quotes.patch(saved.id, { status: 'ready', ...over }))!;
  }

  const get = (t: string) => app.request(`/quote-view?t=${encodeURIComponent(t)}`);

  it('renders a live quote and sends Cache-Control: no-store', async () => {
    const q = await readyQuote();
    const res = await get(signQuoteViewToken(q.id, SECRET));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const body = await res.json();
    expect(body.state).toBe('live');
    expect(body.view.heroTotalUsd).toBe('$114.50');
    expect(body.view.options).toHaveLength(1);
  });

  it('never leaks margin', async () => {
    const q = await readyQuote();
    const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();
    const s = JSON.stringify(body);
    expect(s).not.toMatch(/margin/i);
    expect(s).not.toMatch(/rateCard|costPerKm|hotZone/i);
  });

  it('FOLLOWS the quote — an edit does not kill the link', async () => {
    const q = await readyQuote();
    const token = signQuoteViewToken(q.id, SECRET);
    const before = await (await get(token)).json();
    expect(before.view.title).toBeTruthy();

    // Both legs stretched to 300km (engine total for these: 24900 cents = $249, verified the
    // same way as quoteInput()'s original total) — a real content edit, not just a totalCents
    // relabel, so the route's recompute-against-the-locked-card actually has something to follow.
    const editedInput = quoteInput();
    const edited = {
      ...editedInput,
      totalCents: 24_900,
      request: {
        engine: { ...editedInput.request.engine, legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', distanceKm: 300 },
          { from: 'Sigiriya', to: 'Kandy', distanceKm: 300 },
        ] },
        tool: { ...editedInput.request.tool, legs: [
          { from: 'Colombo Airport', to: 'Sigiriya', date: '2026-08-20', distanceKm: 300 },
          { from: 'Sigiriya', to: 'Kandy', date: '2026-08-22', distanceKm: 300 },
        ] },
      },
      result: { totalCents: 24_900, marginEstimateCents: 1_700, lineItems: [] },
    } as never;
    await quotes.update(q.id, edited);
    await quotes.patch(q.id, { status: 'ready' });

    const after = await (await get(token)).json();
    expect(after.state).toBe('live');
    expect(after.view.heroTotalUsd).toBe('$249');
  });

  it('reads as lapsed past offerValidUntil, still returning the itinerary', async () => {
    const q = await readyQuote({ offerValidUntil: new Date('2026-08-01T00:00:00Z') });
    const app2 = createApp({ quotes, bookingLinkSecret: SECRET, now: () => Date.parse('2026-08-20T00:00:00Z') });
    const res = await app2.request(`/quote-view?t=${signQuoteViewToken(q.id, SECRET)}`);
    const body = await res.json();
    expect(body.state).toBe('lapsed');
    expect(body.view.days.length).toBeGreaterThan(0);
    expect(body.validUntil).toContain('2026-08-01');
  });

  it('is unavailable for draft, lost and soft-deleted quotes', async () => {
    for (const status of ['draft', 'lost'] as const) {
      const q = await readyQuote();
      await quotes.patch(q.id, { status });
      expect((await (await get(signQuoteViewToken(q.id, SECRET))).json()).state).toBe('unavailable');
    }
    const gone = await readyQuote();
    await quotes.softDelete(gone.id, 'ops@ceylonhop.com');
    expect((await (await get(signQuoteViewToken(gone.id, SECRET))).json()).state).toBe('unavailable');
  });

  it('answers a soft 200 unavailable for a bad or foreign token — never a 404 probe', async () => {
    for (const t of ['nonsense', signQuoteViewToken('11111111-2222-4333-8444-555555555555', SECRET)]) {
      const res = await get(t);
      expect(res.status).toBe(200);
      expect((await res.json()).state).toBe('unavailable');
    }
  });

  it('refuses a pay token', async () => {
    const q = await readyQuote();
    const body = await (await get(signQuotePayToken(q.id, q.revision, SECRET, 0))).json();
    expect(body.state).toBe('unavailable');
  });

  it('shows the keepsake for a won quote', async () => {
    const q = await readyQuote();
    await quotes.patch(q.id, { status: 'sent' });
    await quotes.patch(q.id, { status: 'won' });
    const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();
    expect(body.state).toBe('booked');
    expect(body.booked.firstName).toBe('Anna');
  });

  // requestedService: 'both' exercises servicesFor's chauffeur-pricing path — chauffeurFromPrivate
  // reconstructs a chauffeur engine request from the stored private one. None of the tests above
  // touch it, so it shipped uncovered; these three pin its offerability gates and its price.
  describe('requestedService: both — the chauffeur reconstruction path', () => {
    it('a dated multi-day private quote returns two options, the second chauffeur, with a real engine total', async () => {
      const input = { ...quoteInput(), requestedService: 'both' as const };
      const saved = await quotes.save(input as never);
      const q = (await quotes.patch(saved.id, { status: 'ready' }))!;
      const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();

      expect(body.state).toBe('live');
      expect(body.view.options).toHaveLength(2);
      expect(body.view.options[0].service).toBe('private');
      expect(body.view.options[0].totalCents).toBe(11_450);
      expect(body.view.options[1].service).toBe('chauffeur');
      // 22750 = quote/engine.ts's quote() run directly against RATE_CARD for the equivalent
      // chauffeur request (same two legs, dated 2026-08-20 and 2026-08-22) — verified by running
      // the engine, not guessed.
      expect(body.view.options[1].totalCents).toBe(22_750);
      expect(body.view.options[1].totalUsd).toBe('$227.50');
    });

    it('a quote whose legs are all on one date returns one option — chauffeur is not offerable', async () => {
      const base = quoteInput();
      const input = {
        ...base,
        requestedService: 'both' as const,
        request: {
          ...base.request,
          tool: {
            ...base.request.tool,
            legs: base.request.tool.legs.map((l) => ({ ...l, date: '2026-08-20' })),
          },
        },
      };
      const saved = await quotes.save(input as never);
      const q = (await quotes.patch(saved.id, { status: 'ready' }))!;
      const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();

      expect(body.state).toBe('live');
      expect(body.view.options).toHaveLength(1);
      expect(body.view.options[0].service).toBe('private');
    });

    it('a quote with any undated leg returns one option — chauffeur is not offerable', async () => {
      const base = quoteInput();
      const input = {
        ...base,
        requestedService: 'both' as const,
        request: {
          ...base.request,
          tool: {
            ...base.request.tool,
            legs: [
              base.request.tool.legs[0],
              { ...base.request.tool.legs[1], date: undefined },
            ],
          },
        },
      };
      const saved = await quotes.save(input as never);
      const q = (await quotes.patch(saved.id, { status: 'ready' }))!;
      const body = await (await get(signQuoteViewToken(q.id, SECRET))).json();

      expect(body.state).toBe('live');
      expect(body.view.options).toHaveLength(1);
      expect(body.view.options[0].service).toBe('private');
    });
  });
});
