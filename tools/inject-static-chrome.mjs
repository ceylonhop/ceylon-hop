// tools/inject-static-chrome.mjs
// Bake the footer into the hand-written pages' HTML, instead of leaving it to site.js.
//
// WHY. The footer holds the only sitewide link to the route index (`trip/`), and from there to
// the 44 route pages. The generated pages (route pages, terms, privacy, 404) already ship it
// statically via render-page.mjs → site-chrome.mjs. The seven pages below are hand-written and
// mounted it at runtime, so a crawler that does not execute JavaScript saw four internal links
// on the homepage and no path into /trip/ at all — measured on the live apex 2026-09-20, the day
// the apex cutover handed these pages the old WordPress site's rankings.
//
// SAFE BY CONSTRUCTION. site.js does `host.innerHTML = …`, so at runtime it REPLACES what we
// write here. Two consequences worth stating:
//   1. No duplicate footer, and nothing to un-mount — the runtime path is unchanged.
//   2. The markup we inject must MATCH what site.js renders, or a link would appear or vanish
//      when JS loads. site-chrome.mjs's footer was two links short (Cancellation policy, Photo
//      credits); it was aligned in the same change. `npm run check:chrome-parity` — the test
//      web-tests/unit/static-chrome-crawlable.test.js — is what keeps them from drifting again.
//
// This changes NO customer-facing link target. The homepage transfer cards still go to
// search.html: one place per pair, owner decision 2026-09-19 (#641 reverted #591).
//
// Idempotent: it replaces the entire contents of the <div data-footer> host, so running it
// twice is the same as running it once. Part of `npm run generate`.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderFooter } from './site-chrome.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Hand-written, root-level pages. The generated ones get their chrome from render-page.mjs. */
export const PAGES = ['index.html', 'about.html', 'blog.html', 'tours.html', 'why.html', 'plan.html', 'search.html'];

// Matches the host whether it is empty (<div data-footer></div>) or already filled by a
// previous run. Non-greedy up to the first </div> that closes it — the footer markup itself
// contains nested divs, so we anchor on the host's own opening tag and rebuild it wholesale.
const HOST = /<div data-footer>[\s\S]*?<\/div>\s*(?=<script|<\/body>)/;

/** @returns the page HTML with the footer baked into its [data-footer] host. */
export function injectFooter(html, prefix = '') {
  const footer = renderFooter(prefix);
  const block = `<div data-footer>${footer}</div>\n`;
  if (HOST.test(html)) return html.replace(HOST, block);
  // An empty self-contained host, before anything else has been injected.
  if (html.includes('<div data-footer></div>')) return html.replace('<div data-footer></div>', block);
  throw new Error('inject-static-chrome: no [data-footer] host found — page layout changed?');
}

export function injectAll({ write = true } = {}) {
  const results = [];
  for (const page of PAGES) {
    const file = path.join(ROOT, page);
    const before = readFileSync(file, 'utf8');
    const after = injectFooter(before, '');
    if (write && after !== before) writeFileSync(file, after);
    results.push([page, after !== before]);
  }
  return results;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const changed = injectAll().filter(([, c]) => c).length;
  console.log(`static chrome: ${PAGES.length} pages checked, ${changed} updated`);
}
