import { describe, expect, it } from 'vitest';
import { createApp as realCreateApp, type AppDeps } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import {
  InMemoryCustomerShortLinkRepo,
  type CustomerShortLinkRepo,
} from '../db/customerShortLinkRepo';
import { signSession } from '../lib/opsAuth';
import { verifyQuotePayToken, verifyQuoteViewToken } from '../lib/bookingToken';

/*
  Step 2 (spec 2026-08-24 §11): the two existing mint endpoints return the branded /s/ alias when
  CUSTOMER_SHORT_LINKS_ENABLED is on, and the unchanged long URL when it is off. Only `url` moves —
  status, shape and every side effect stay exactly as they were.
*/

const AUTH = {
  opsUsers: 'f@x.com:founder',
  googleClientId: 'cid',
  opsSessionSecret: 'sek',
};
const SECRET = 'test-link-secret';
const BASES = { quoteBaseUrl: 'https://quote.example', payBaseUrl: 'https://pay.example' };
const FOUNDER = `ch_ops=${signSession({ email: 'f@x.com', exp: Date.now() + 60_000 }, AUTH.opsSessionSecret)}`;

type App = ReturnType<typeof realCreateApp>;
function createApp(deps: AppDeps = {}): App {
  return realCreateApp({ auth: AUTH, adminApiKey: 'k', bookingLinkSecret: SECRET, ...BASES, ...deps });
}

async function readyQuote(quotes: InMemoryQuoteRepo): Promise<string> {
  const q = await quotes.save({
    channel: 'ops', product: 'private', vehicle: 'car', totalCents: 21900, currency: 'USD',
    rateCardVersion: 'v1', result: {}, requestedService: 'private',
    request: {
      tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120, date: '2026-09-01' }] },
      engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] },
    },
  });
  await quotes.patch(q.id, { status: 'pending_review' as never });
  await quotes.patch(q.id, { status: 'ready' as never });
  return q.id;
}

const post = (app: App, path: string, body?: unknown) => app.request(path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', cookie: FOUNDER },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const mintPay = (app: App, id: string, body?: unknown) => post(app, `/admin/quote/${id}/pay-link`, body);
const mintQuote = (app: App, id: string) => post(app, `/admin/quote/${id}/quote-link`);

const SHORT = /^https:\/\/(pay|quote)\.example\/s\/[A-Za-z0-9_-]{16}$/;

describe('mint endpoints with customer short links OFF (default)', () => {
  it('returns the unchanged long pay and quote URLs', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const app = createApp({ quotes, shortLinks: new InMemoryCustomerShortLinkRepo() });

    const pay = await mintPay(app, id);
    expect(pay.status).toBe(200);
    expect((await pay.json()).url as string).toMatch(/^https:\/\/pay\.example\/p\?t=/);

    const quote = await mintQuote(app, id);
    expect(quote.status).toBe(200);
    expect((await quote.json()).url as string).toMatch(/^https:\/\/quote\.example\/q\?t=/);
  });

  it('writes no alias row while the flag is off', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    let puts = 0;
    const shortLinks: CustomerShortLinkRepo = {
      put: async () => { puts += 1; },
      getByDigest: async () => null,
    };
    const app = createApp({ quotes, shortLinks });
    await mintPay(app, id);
    await mintQuote(app, id);
    expect(puts).toBe(0);
  });
});

describe('mint endpoints with customer short links ON', () => {
  const on = (deps: AppDeps = {}) => createApp({ customerShortLinksEnabled: true, ...deps });

  it('mints a pay alias on the pay host that resolves to the same pinned target', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const shortLinks = new InMemoryCustomerShortLinkRepo();
    const app = on({ quotes, shortLinks });

    const res = await mintPay(app, id);
    expect(res.status).toBe(200);
    const url = (await res.json()).url as string;
    expect(url).toMatch(SHORT);
    expect(url.startsWith('https://pay.example/s/')).toBe(true);

    // The alias must resolve back into the existing signed pay flow.
    const hop = await app.request(url);
    expect(hop.status).toBe(302);
    const location = new URL(hop.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://pay.example/p');
    const claims = verifyQuotePayToken(location.searchParams.get('t') ?? undefined, SECRET);
    expect(claims).toMatchObject({ quoteId: id });
  });

  it('mints a quote alias on the quote host that resolves to the quote view', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const shortLinks = new InMemoryCustomerShortLinkRepo();
    const app = on({ quotes, shortLinks });

    const res = await mintQuote(app, id);
    expect(res.status).toBe(200);
    const url = (await res.json()).url as string;
    expect(url).toMatch(SHORT);
    expect(url.startsWith('https://quote.example/s/')).toBe(true);

    const hop = await app.request(url);
    expect(hop.status).toBe(302);
    const location = new URL(hop.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://quote.example/q');
    expect(verifyQuoteViewToken(location.searchParams.get('t') ?? undefined, SECRET))
      .toEqual({ quoteId: id });
  });

  it('is byte-identical on re-copy — the property ops relies on', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const app = on({ quotes, shortLinks: new InMemoryCustomerShortLinkRepo() });

    const payA = (await (await mintPay(app, id)).json()).url;
    const payB = (await (await mintPay(app, id)).json()).url;
    expect(payB).toBe(payA);

    const qA = (await (await mintQuote(app, id)).json()).url;
    const qB = (await (await mintQuote(app, id)).json()).url;
    expect(qB).toBe(qA);
  });

  it('preserves the rest of the pay-link response shape', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const app = on({ quotes, shortLinks: new InMemoryCustomerShortLinkRepo() });
    const body = await (await mintPay(app, id)).json();
    expect(body).toHaveProperty('payhereMode');
    expect(body).toHaveProperty('amountCents');
    expect(body).toHaveProperty('coverage');
  });

  // A dead link in a customer's WhatsApp thread is worse than a long one: if the alias cannot be
  // persisted we must hand ops the long URL that has always worked, not a code nothing resolves.
  it('falls back to the long URL when the alias cannot be stored', async () => {
    const quotes = new InMemoryQuoteRepo();
    const id = await readyQuote(quotes);
    const shortLinks: CustomerShortLinkRepo = {
      put: async () => { throw new Error('database unavailable'); },
      getByDigest: async () => null,
    };
    const app = on({ quotes, shortLinks });

    const pay = await mintPay(app, id);
    expect(pay.status).toBe(200);
    expect((await pay.json()).url as string).toMatch(/^https:\/\/pay\.example\/p\?t=/);

    const quote = await mintQuote(app, id);
    expect(quote.status).toBe(200);
    expect((await quote.json()).url as string).toMatch(/^https:\/\/quote\.example\/q\?t=/);
  });
});
