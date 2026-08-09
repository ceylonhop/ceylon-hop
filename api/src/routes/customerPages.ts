import { Hono, type Context } from 'hono';
import { Resvg } from '@resvg/resvg-js';
import { readFileSync } from 'node:fs';
import type { QuoteRepo } from '../db/quoteRepo';
import { verifyQuotePayToken, verifyQuoteViewToken } from '../lib/bookingToken';
import { payCardModel, payCardSvg, payCardMeta, GENERIC_PAY_CARD, type PayCardModel } from './payCard';
import { quoteCardModel, quoteCardSvg, quoteCardMeta, GENERIC_QUOTE_CARD, type QuoteCardModel } from './quoteCard';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

// Serve the customer payment pages (manage.html, pay.html) from the API host itself.
//
// Why: these are files of the CUSTOMER SITE, but the links that carry customers to them are
// minted by the API from APP_BASE_URL — and staging has no customer site at all. The first
// staging test proved it (owner report, 2026-07-31): the ops drawer handed out
// ops.staging.ceylonhop.com/manage.html?t=…, and the API host answered 404. Serving the
// pages here makes an APP_BASE_URL that points at the API host self-sufficient, so staging
// works with no second deployment. Prod is unaffected — its APP_BASE_URL stays on
// ceylonhop.com and these routes are just a same-content mirror.
//
// Two rewrites are applied on the way out, both only meaningful for this mirror:
//   1. window.CEYLON_HOP_API = location.origin, injected ahead of the page's own default
//      (which hard-codes the PROD api — the cross-environment trap board.html is known for).
//      The page's `window.CEYLON_HOP_API || '…'` keeps whatever we set.
//   2. the brand link href="index.html" → the real site, which the API host doesn't serve.
//
// MOUNT ORDER MATTERS: mount this BEFORE the share-card root routes in app.ts. Their
// "/:code" param route matches /pay.html and answers 404 rather than falling through
// (customerPages.test.ts asserts this end-to-end, through the real createApp).

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

// Same bundled faces the ride card uses — Resvg runs with loadSystemFonts:false.
const FONT_FILES = ['BodoniModa-ExtraBold.ttf', 'Poppins-Bold.ttf', 'Poppins-Regular.ttf']
  .map((f) => fileURLToPath(new URL(`../../assets/fonts/${f}`, import.meta.url)));

export interface CustomerPagesDeps {
  /** Enables the per-token share card. Without it every pay link gets the generic card. */
  quotes?: QuoteRepo;
  linkSecret?: string;
  /** Absolute origin for og:url / og:image. Falls back to the request's own origin. */
  payBaseUrl?: string;
  /** Same, for quote links. Falls back to payBaseUrl, matching how the mint resolves its base. */
  quoteBaseUrl?: string;
}
const SITE_HOME = 'https://ceylonhop.com/';

const JS = 'text/javascript; charset=utf-8';

const PAGES = ['manage.html', 'pay.html', 'quote.html'];
const ASSETS: [string, string][] = [
  ['site.css', 'text/css; charset=utf-8'],
  ['ticket.css', 'text/css; charset=utf-8'], // the shared travel-document design, loaded by BOTH pages
  ['quote.css', 'text/css; charset=utf-8'],
  ['favicon.svg', 'image/svg+xml'],
  ['analytics.js', JS],
  ['consent.js', JS],
  ['phone-countries.js', JS],
  ['decline-help.js', JS], // the decline-recovery copy pay.html shares with booking.html
  ['ch-map.js', JS], // the shared route renderer, same file booking.js and plan.js use
  ['img/ceylon-hop-touch-icon.png', 'image/png'],
  ['img/brand-c.svg', 'image/svg+xml'], // the header logo glyph — same file site.js's cmark() uses
];

// Read-through cache: these files never change within a deploy.
const cache = new Map<string, string | ArrayBuffer | null>();

/** Binary assets go out as a plain ArrayBuffer — Node's Buffer is not one of c.body()'s types. */
function bytes(rel: string): ArrayBuffer {
  const b = readFileSync(join(ROOT, rel));
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

function read(rel: string, transform?: (s: string) => string) {
  if (!cache.has(rel)) {
    try {
      cache.set(rel, transform ? transform(readFileSync(join(ROOT, rel), 'utf8')) : bytes(rel));
    } catch {
      cache.set(rel, null); // not in this checkout — answer 404 rather than crash the API
    }
  }
  return cache.get(rel) ?? null;
}

// ── WhatsApp/OG share card for pay links (spec 2026-08-02) ────────────────────────────────
// The crawler does not run JavaScript, and pay.html renders from a fetch after load — so the
// tags must be built HERE, per token, or the link unfurls as a bare URL right before a payment
// request. Every state renders SOMETHING: a preview that fails reads as a broken link, and the
// dead-state fallback is one identical generic card so a crawler cannot probe token validity
// by diffing previews.
function ogTags(meta: { title: string; description: string }, pageUrl: string, imageUrl: string): string {
  const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
  return [
    ['og:type', 'website'], ['og:site_name', 'Ceylon Hop'],
    ['og:title', meta.title], ['og:description', meta.description],
    ['og:image', imageUrl],
    // WhatsApp needs EXPLICIT dimensions to render the large card. With og:image alone it
    // fetched the tags fine — title and description updated — and then fell back to a
    // text-only preview with no picture (owner-reported, 2026-08-02). The crawler will not
    // measure the image itself, so declaring 1200x630 up front is what unlocks the card.
    ['og:image:width', '1200'], ['og:image:height', '630'], ['og:image:type', 'image/png'],
    ['og:image:alt', 'Ceylon Hop — secure payment'],
    ['og:url', pageUrl],
    ['twitter:card', 'summary_large_image'], ['twitter:title', meta.title],
    ['twitter:description', meta.description], ['twitter:image', imageUrl],
  ].map(([k, v]) => `<meta property="${k}" content="${esc(v)}">`).join('\n');
}

/**
 * Absolute origin for og:url / og:image. Meta silently ignores a RELATIVE og:image — no
 * picture, which is the whole point of the endpoint — and staging's APP_BASE_URL is
 * scheme-less, so trusting the configured value directly emitted exactly that (caught on
 * staging, 2026-08-02). Render also terminates TLS at its edge, so `c.req.url` inside the
 * container is http:// even when the world reached us over https; x-forwarded-proto is the
 * truth. Same reasoning as shareCard.ts's origin(), which is why they look alike.
 */
function absoluteOrigin(configured: string | undefined, c: Context): string {
  if (configured) {
    const trimmed = configured.replace(/\/$/, '');
    return /^https?:\/\//.test(trimmed) ? trimmed : `https://${trimmed}`;
  }
  const url = new URL(c.req.url);
  const proto = (c.req.header('x-forwarded-proto') || url.protocol.replace(':', '')).split(',')[0].trim();
  return `${proto}://${url.host}`;
}

const forApiHost = (html: string) =>
  html
    .replace('<head>', '<head>\n<script>window.CEYLON_HOP_API=location.origin;</script>')
    .replaceAll('href="index.html"', `href="${SITE_HOME}"`);

export function customerPagesRoutes(deps: CustomerPagesDeps = {}) {
  const r = new Hono();

  /** The card model for a token, or the generic card for anything that isn't payable. */
  async function modelFor(token: string | undefined): Promise<PayCardModel> {
    if (!token || !deps.quotes || !deps.linkSecret) return GENERIC_PAY_CARD;
    try {
      const parsed = verifyQuotePayToken(token, deps.linkSecret);
      if (!parsed) return GENERIC_PAY_CARD;
      const quote = await deps.quotes.get(parsed.quoteId);
      // Same gate the pay page itself applies: only a live, current quote shows its trip.
      if (!quote || quote.revision !== parsed.revision) return GENERIC_PAY_CARD;
      if (quote.status !== 'ready' && quote.status !== 'sent') return GENERIC_PAY_CARD;
      return payCardModel(quote);
    } catch {
      return GENERIC_PAY_CARD; // never a 500 to a crawler
    }
  }

  // The card image. Same shape and cache policy as the ride card's /:code/card.png.
  r.get('/pay/card.png', async (c) => {
    const model = await modelFor(c.req.query('t'));
    const png = new Resvg(payCardSvg(model), {
      font: { fontFiles: FONT_FILES, loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300, s-maxage=300',
    });
  });

  /** The card model for a quote-view token, or the generic card for anything not live. */
  async function quoteModelFor(token: string | undefined): Promise<QuoteCardModel> {
    if (!token || !deps.quotes || !deps.linkSecret) return GENERIC_QUOTE_CARD;
    try {
      const parsed = verifyQuoteViewToken(token, deps.linkSecret);
      if (!parsed) return GENERIC_QUOTE_CARD;
      const quote = await deps.quotes.get(parsed.quoteId);
      // Same gate the page applies. Deliberately NO revision check: a quote link FOLLOWS its
      // quote (spec D3), so an edited quote still has a real card — unlike the pay card, whose
      // token pins a revision. Lapsed quotes keep their card too: the PRICE went stale, and the
      // card never carried one.
      if (!quote || (quote.status !== 'ready' && quote.status !== 'sent')) return GENERIC_QUOTE_CARD;
      return quoteCardModel(quote);
    } catch {
      return GENERIC_QUOTE_CARD; // never a 500 to a crawler
    }
  }

  // The quote card image. Same shape and cache policy as /pay/card.png. The 5-minute s-maxage is
  // deliberate even though the page itself is no-store: WhatsApp caches the preview against the
  // URL for days regardless of what we send, which is exactly why nothing time-sensitive (a
  // price, a countdown) is on the card in the first place.
  r.get('/quote/card.png', async (c) => {
    const model = await quoteModelFor(c.req.query('t'));
    const png = new Resvg(quoteCardSvg(model), {
      font: { fontFiles: FONT_FILES, loadSystemFonts: false },
      fitTo: { mode: 'width', value: 1200 },
    }).render().asPng();
    return c.body(new Uint8Array(png), 200, {
      'content-type': 'image/png',
      'cache-control': 'public, max-age=300, s-maxage=300',
    });
  });

  // `/p` is the SHORT alias for pay.html (2026-08-02) — the path shed 8 characters of a URL
  // that was 208 long. `/q` is the same idea for quote.html, which is minted into every
  // quote-link URL. Same handler, same OG injection: an alias, not a second page.
  for (const page of [...PAGES, 'p', 'q']) {
    const file = page === 'p' ? 'pay.html' : page === 'q' ? 'quote.html' : page;
    r.get(`/${page}`, async (c) => {
      const html = read(file, forApiHost) as string | null;
      if (html === null) return c.notFound();
      // manage.html still does not unfurl — it is sent after payment, when trust is already
      // established (spec: deliberately deferred).
      if (file !== 'pay.html' && file !== 'quote.html') return c.html(html);
      const token = c.req.query('t');
      const isQuote = file === 'quote.html';
      // Each page's links are minted against its own base, so each unfurls against its own
      // origin — a quote card served from the pay host would make og:url disagree with the URL
      // the customer actually tapped.
      const origin = absoluteOrigin(isQuote ? (deps.quoteBaseUrl ?? deps.payBaseUrl) : deps.payBaseUrl, c);
      const meta = isQuote
        ? quoteCardMeta(await quoteModelFor(token))
        : payCardMeta(await modelFor(token));
      const cardPath = isQuote ? '/quote/card.png' : '/pay/card.png';
      const image = `${origin}${cardPath}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
      const page_ = `${origin}/${page}${token ? `?t=${encodeURIComponent(token)}` : ''}`;
      return c.html(html.replace('<head>', `<head>\n${ogTags(meta, page_, image)}`));
    });
  }
  for (const [rel, type] of ASSETS) {
    r.get(`/${rel}`, (c) => {
      const body = read(rel) as ArrayBuffer | null;
      return body === null ? c.notFound() : c.body(body, 200, { 'content-type': type });
    });
  }
  return r;
}
