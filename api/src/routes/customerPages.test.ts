import { describe, it, expect } from 'vitest';
import { createApp } from '../app';
import { InMemoryQuoteRepo } from '../db/quoteRepo';
import { signQuotePayToken } from '../lib/bookingToken';
import { customerPagesRoutes } from './customerPages';

// The staging 404 (owner report, 2026-07-31): a payment link minted against APP_BASE_URL
// pointed at the API host — ops.staging.ceylonhop.com/manage.html — and the API had no such
// page. These run through the REAL createApp, because the bug that made this necessary and
// the bug most likely to undo it are both about ROUTING, not about reading a file.

const app = createApp();
const get = (path: string) => app.request(path);

describe('customer pay pages are served by the API host', () => {
  it('serves pay.html and manage.html as HTML, not 404', async () => {
    for (const page of ['/pay.html', '/manage.html']) {
      const res = await get(page);
      expect(res.status, `${page} must not 404 — this is the staging bug`).toBe(200);
      expect(res.headers.get('content-type')).toContain('text/html');
      expect(await res.text()).toContain('<!doctype html>');
    }
  });

  it('points the page at the SERVING origin, not the hard-coded prod API', async () => {
    // pay.html defaults to `window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com'`.
    // Left alone, a page served by staging would talk to PROD. The injected line must come
    // first in <head> so the page's own `||` keeps it.
    const html = await (await get('/pay.html')).text();
    const injected = html.indexOf('window.CEYLON_HOP_API=location.origin');
    const pageDefault = html.indexOf("window.CEYLON_HOP_API = window.CEYLON_HOP_API ||");
    expect(injected).toBeGreaterThan(-1);
    expect(pageDefault).toBeGreaterThan(-1);
    expect(injected, 'origin must be set BEFORE the page default').toBeLessThan(pageDefault);
  });

  it('sends the brand link to the real site — the API host has no index.html', async () => {
    const html = await (await get('/manage.html')).text();
    expect(html).not.toContain('href="index.html"');
    expect(html).toContain('href="https://ceylonhop.com/"');
  });

  it('serves the assets the pages actually reference', async () => {
    const cases: [string, string][] = [
      ['/site.css', 'text/css'],
      ['/ticket.css', 'text/css'],
      ['/phone-countries.js', 'javascript'],
      ['/analytics.js', 'javascript'],
      ['/consent.js', 'javascript'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/img/ceylon-hop-touch-icon.png', 'image/png'],
      ['/img/ceylon-hop-c.png', 'image/png'],
    ];
    for (const [path, type] of cases) {
      const res = await get(path);
      expect(res.status, `${path} missing — the page would render unstyled/broken`).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
    }
  });

  it('pay.html uses the REAL logo file, not a hand-drawn C', async () => {
    // The first cut drew its own stroke-path "C" in a saffron square. It read as almost-right,
    // which is worse than obviously wrong (owner caught it, 2026-07-31). The brand mark is a
    // file — img/ceylon-hop-c.png, the same one site.js's cmark() serves the header.
    const html = await (await get('/pay.html')).text();
    expect(html).toContain('src="img/ceylon-hop-c.png"');
    expect(html, 'no bespoke logo path drawing').not.toMatch(/pp-cmark"><svg/);
  });

  it('is mounted ahead of the share-card root route, which matches /pay.html', async () => {
    // shareCardRoutes(…, {guardCode:true}) registers "/:code" at the root. It matched
    // /pay.html and answered 404 in the local rig until the static routes were registered
    // first. If someone moves this mount below it, this is the test that fails.
    expect((await get('/pay.html')).status).toBe(200);
  });

  it('does not shadow the ops shell at the bare root', async () => {
    const res = await get('/');
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('<!doctype html>');
  });
});

// ── WhatsApp share card (spec 2026-08-02) ────────────────────────────────────────────────
// Ops sends pay links over WhatsApp. With no og: tags the message unfurled as a bare
// 200-character token URL immediately before asking for money — the visual grammar of a
// phishing link. The crawler runs no JavaScript, so these tags MUST be server-rendered.
describe('pay links unfurl as a Ceylon Hop card', () => {
  const SECRET = 'test-link-secret';
  const cardApp = (quotes: InMemoryQuoteRepo) =>
    createApp({ quotes, bookingLinkSecret: SECRET, auth: { opsUsers: 'f@x.com:founder', googleClientId: 'c', opsSessionSecret: 's' }, adminApiKey: 'k' });

  async function payableQuote(quotes: InMemoryQuoteRepo) {
    const q = await quotes.save({
      channel: 'ops', product: 'private', vehicle: 'car', customerName: 'Nimal Perera',
      customerContact: '+94770001111', totalCents: 45800, currency: 'USD', rateCardVersion: 'v1',
      request: {
        tool: { vehicle: 'car', passengerCount: 2, luggageCount: 1,
          legs: [{ from: 'Colombo Airport (CMB)', to: 'Galle', distanceKm: 120, date: '2026-09-01', category: 'transfer' }] },
        engine: { product: 'private', vehicle: 'car', pax: 2, bags: 1, legs: [{ from: 'CMB', to: 'Galle', distanceKm: 120 }] },
      },
      result: { totalCents: 45800 },
    });
    await quotes.patch(q.id, { status: 'pending_review' });
    await quotes.patch(q.id, { status: 'ready' });
    return quotes.get(q.id);
  }

  it('a payable token puts the TRIP in the card — the part a phisher could not know', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await payableQuote(quotes);
    const t = signQuotePayToken(q!.id, q!.revision, SECRET);
    const html = await (await cardApp(quotes).request(`/pay.html?t=${encodeURIComponent(t)}`)).text();
    expect(html).toContain('og:image');
    expect(html).toContain('summary_large_image');
    expect(html).toContain('Colombo Airport (CMB) → Galle');
    expect(html).toContain('/pay/card.png');
  });

  // THE decision this feature turns on (owner, 2026-08-02): the card is public to anyone the
  // link reaches — group chats, lock screens, forwards — so the amount stays off it.
  it('NEVER puts the amount in the preview', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await payableQuote(quotes);
    const t = signQuotePayToken(q!.id, q!.revision, SECRET);
    const html = await (await cardApp(quotes).request(`/pay.html?t=${encodeURIComponent(t)}`)).text();
    const head = html.slice(0, html.indexOf('</head>'));
    expect(head).not.toContain('458');
    expect(head).not.toContain('$');
  });

  it('every dead state falls back to the SAME generic card, so validity cannot be probed', async () => {
    const quotes = new InMemoryQuoteRepo();
    const q = await payableQuote(quotes);
    const app = cardApp(quotes);
    const stale = signQuotePayToken(q!.id, q!.revision + 1, SECRET); // revised
    const garbage = 'not-a-real-token';
    const previews = await Promise.all([stale, garbage].map(async (t) => {
      const res = await app.request(`/pay.html?t=${encodeURIComponent(t)}`);
      expect(res.status).toBe(200); // a crawler must never see 404/500
      const html = await res.text();
      expect(html).not.toContain('Colombo Airport (CMB) → Galle'); // no trip leaks
      return html.slice(0, html.indexOf('</head>')).replace(/t=[^"&]*/g, '');
    }));
    expect(previews[0]).toBe(previews[1]); // identical — nothing to diff
  });

  it('serves the card image as a real PNG with the chat-app cache header', async () => {
    const res = await cardApp(new InMemoryQuoteRepo()).request('/pay/card.png');
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('cache-control')).toContain('max-age=300');
    const bytes = new Uint8Array(await res.arrayBuffer());
    expect(Array.from(bytes.slice(1, 4))).toEqual([0x50, 0x4e, 0x47]); // PNG magic
  });
});

// Caught on staging, not by a test (2026-08-02): staging's APP_BASE_URL is scheme-less, so
// og:image rendered as "ops.staging.ceylonhop.com/pay/card.png" — and Meta requires an
// ABSOLUTE url. A relative og:image is silently ignored: no picture, which is the entire
// point of the endpoint. Render also terminates TLS at its edge, so c.req.url inside the
// container is http:// even when the world reached us over https.
describe('og:image and og:url are always absolute https', () => {
  it('repairs a scheme-less configured base url', async () => {
    const r = customerPagesRoutes({ payBaseUrl: 'ops.staging.ceylonhop.com' });
    const html = await (await r.request('/pay.html?t=x')).text();
    expect(html).toContain('content="https://ops.staging.ceylonhop.com/pay/card.png');
    expect(html).toContain('content="https://ops.staging.ceylonhop.com/pay.html');
  });

  it('honours x-forwarded-proto when no base url is configured', async () => {
    const r = customerPagesRoutes();
    const html = await (await r.request('/pay.html', { headers: { 'x-forwarded-proto': 'https' } })).text();
    expect(html).toMatch(/og:image" content="https:\/\//);
  });
});
