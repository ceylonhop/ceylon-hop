import { Hono } from 'hono';
import { readFileSync } from 'node:fs';
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
const SITE_HOME = 'https://ceylonhop.com/';

const JS = 'text/javascript; charset=utf-8';

const PAGES = ['manage.html', 'pay.html'];
const ASSETS: [string, string][] = [
  ['site.css', 'text/css; charset=utf-8'],
  ['favicon.svg', 'image/svg+xml'],
  ['analytics.js', JS],
  ['consent.js', JS],
  ['phone-countries.js', JS],
  ['img/ceylon-hop-touch-icon.png', 'image/png'],
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

const forApiHost = (html: string) =>
  html
    .replace('<head>', '<head>\n<script>window.CEYLON_HOP_API=location.origin;</script>')
    .replaceAll('href="index.html"', `href="${SITE_HOME}"`);

export function customerPagesRoutes() {
  const r = new Hono();
  for (const page of PAGES) {
    r.get(`/${page}`, (c) => {
      const html = read(page, forApiHost) as string | null;
      return html === null ? c.notFound() : c.html(html);
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
