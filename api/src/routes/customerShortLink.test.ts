import { describe, expect, it } from 'vitest';
import { FakeAlertAdapter } from '../adapters/alerts';
import { createApp } from '../app';
import {
  InMemoryCustomerShortLinkRepo,
  type CustomerShortLinkRepo,
  type CustomerShortLinkTarget,
} from '../db/customerShortLinkRepo';
import { customerShortCode, customerShortCodeDigest } from '../lib/customerShortLink';
import { verifyQuotePayToken, verifyQuoteViewToken } from '../lib/bookingToken';

const SECRET = 'resolver-test-secret';
const QUOTE_ID = '11111111-2222-4333-8444-555555555555';
const BASES = { quoteBaseUrl: 'https://quote.example', payBaseUrl: 'https://pay.example' };

async function seeded(target: CustomerShortLinkTarget) {
  const shortLinks = new InMemoryCustomerShortLinkRepo();
  const code = customerShortCode(target, SECRET);
  await shortLinks.put(customerShortCodeDigest(code), target);
  const app = createApp({ shortLinks, bookingLinkSecret: SECRET, ...BASES });
  return { app, code };
}

describe('GET /s/:code — customer short-link resolver', () => {
  it('redirects a quote alias to a valid existing quote-view token', async () => {
    const { app, code } = await seeded({ kind: 'quote_view', quoteId: QUOTE_ID });
    const res = await app.request(`https://quote.example/s/${code}`);

    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://quote.example/q');
    expect(verifyQuoteViewToken(location.searchParams.get('t') ?? undefined, SECRET)).toEqual({ quoteId: QUOTE_ID });
  });

  it('redirects a pay alias to the pinned revision and selection on the pay host', async () => {
    const target = { kind: 'quote_pay' as const, quoteId: QUOTE_ID, revision: 7, seq: 3 };
    const { app, code } = await seeded(target);
    // The stored kind wins over the incoming hostname.
    const res = await app.request(`https://quote.example/s/${code}`);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://pay.example/p');
    expect(verifyQuotePayToken(location.searchParams.get('t') ?? undefined, SECRET)).toEqual({
      quoteId: QUOTE_ID,
      revision: 7,
      seq: 3,
    });
  });

  it('redirects a quote alias to the quote host even when opened on the pay host', async () => {
    const { app, code } = await seeded({ kind: 'quote_view', quoteId: QUOTE_ID });
    const res = await app.request(`https://pay.example/s/${code}`);

    expect(res.status).toBe(302);
    const location = new URL(res.headers.get('location')!);
    expect(`${location.origin}${location.pathname}`).toBe('https://quote.example/q');
    expect(verifyQuoteViewToken(location.searchParams.get('t') ?? undefined, SECRET)).toEqual({ quoteId: QUOTE_ID });
  });

  it('does not query storage for a malformed code', async () => {
    let gets = 0;
    const shortLinks: CustomerShortLinkRepo = {
      put: async () => undefined,
      getByDigest: async () => { gets += 1; return null; },
    };
    const app = createApp({ shortLinks, bookingLinkSecret: SECRET, ...BASES });
    const res = await app.request('https://quote.example/s/not-valid');

    expect(res.status).toBe(302);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const location = new URL(res.headers.get('location')!);
    expect(location.pathname).toBe('/q');
    expect(location.searchParams.get('t')).toBe('invalid');
    expect(gets).toBe(0);
  });

  it('sends an unknown valid code to the generic page selected only by the request host', async () => {
    const app = createApp({
      shortLinks: new InMemoryCustomerShortLinkRepo(), bookingLinkSecret: SECRET, ...BASES,
    });
    const code = 'A'.repeat(16);

    const quote = await app.request(`https://quote.example/s/${code}`);
    expect(quote.status).toBe(302);
    expect(quote.headers.get('cache-control')).toBe('no-store');
    const quoteLocation = new URL(quote.headers.get('location')!);
    expect(quoteLocation.pathname).toBe('/q');
    expect(quoteLocation.searchParams.get('t')).toBe('invalid');

    const pay = await app.request(`https://pay.example/s/${code}`);
    expect(pay.status).toBe(302);
    expect(pay.headers.get('cache-control')).toBe('no-store');
    const payLocation = new URL(pay.headers.get('location')!);
    expect(payLocation.pathname).toBe('/p');
    expect(payLocation.searchParams.get('t')).toBe('invalid');

    const other = await app.request(`https://ops.example/s/${code}`);
    expect(other.status).toBe(404);
    expect(other.headers.get('cache-control')).toBe('no-store');
  });

  it('returns a generic 404 for unknown and malformed codes when quote and pay share a host', async () => {
    const app = createApp({
      shortLinks: new InMemoryCustomerShortLinkRepo(),
      bookingLinkSecret: SECRET,
      quoteBaseUrl: 'https://links.example',
      payBaseUrl: 'https://links.example',
    });

    for (const code of ['A'.repeat(16), 'not-valid']) {
      const res = await app.request(`https://links.example/s/${code}`);
      expect(res.status).toBe(404);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(await res.json()).toEqual({ error: 'not_found' });
    }
  });

  it('returns a retryable generic 503 and reports a sanitized route when storage is unavailable', async () => {
    const alerts = new FakeAlertAdapter();
    const shortLinks: CustomerShortLinkRepo = {
      put: async () => undefined,
      getByDigest: async () => { throw new Error('database unavailable'); },
    };
    const app = createApp({ shortLinks, alerts, bookingLinkSecret: SECRET, ...BASES });
    const code = 'A'.repeat(16);
    const res = await app.request(`https://quote.example/s/${code}`);
    expect(res.status).toBe(503);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({ error: 'temporarily_unavailable' });
    expect(alerts.sent).toHaveLength(1);
    expect(alerts.sent[0]).toMatchObject({
      severity: 'critical',
      kind: 'api_error',
      dedupeKey: 'Error:/s/:code',
    });
    expect(alerts.sent[0].title).toContain('/s/:code');
    expect(alerts.sent[0].body).toContain('GET /s/:code');
    expect(JSON.stringify(alerts.sent[0])).not.toContain(code);
  });

  it('applies the existing public per-IP rate limit to resolver reads', async () => {
    const { code } = await seeded({ kind: 'quote_view', quoteId: QUOTE_ID });
    const shortLinks = new InMemoryCustomerShortLinkRepo();
    await shortLinks.put(
      customerShortCodeDigest(code),
      { kind: 'quote_view', quoteId: QUOTE_ID },
    );
    const app = createApp({
      shortLinks,
      bookingLinkSecret: SECRET,
      rateLimit: { max: 1, windowMs: 60_000 },
      ...BASES,
    });
    const headers = { 'x-forwarded-for': '203.0.113.5' };

    expect((await app.request(`https://quote.example/s/${code}`, { headers })).status).toBe(302);
    expect((await app.request(`https://quote.example/s/${code}`, { headers })).status).toBe(429);
  });
});
