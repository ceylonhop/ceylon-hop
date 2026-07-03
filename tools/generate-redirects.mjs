import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { generateAll, ROOT } from './generate-route-pages.mjs';

const ORIGIN = 'https://ceylonhop.com';

export function loadMap() {
  return JSON.parse(readFileSync(join(ROOT, 'tools/redirect-map.json'), 'utf8'));
}

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// A crawlable stub at the old URL: instant meta-refresh + an absolute canonical to
// the new apex URL (so search engines fold the old URL into the new one) + a visible
// link for humans and no-JS clients. Cloudflare Bulk Redirects (real 301s) sit in
// front at cutover; these stubs are the belt-and-suspenders and pre-Cloudflare net.
function stubHtml(to) {
  const canonical = `${ORIGIN}${to}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, follow">
<title>Moved — Ceylon Hop</title>
<link rel="canonical" href="${esc(canonical)}">
<meta http-equiv="refresh" content="0; url=${esc(to)}">
</head>
<body>
<p>This page has moved. If you are not redirected, <a href="${esc(to)}">continue to ${esc(canonical)}</a>.</p>
<script>location.replace(${JSON.stringify(to)});</script>
</body>
</html>
`;
}

function stubPath(from) {
  // from is "/old/path/" → "old/path/index.html"
  return from.replace(/^\//, '') + 'index.html';
}

export function generateRedirects() {
  const map = loadMap();
  const routeTargets = new Set([...generateAll().keys()]
    .filter(k => /^trip\/.+\/index\.html$/.test(k))
    .map(k => '/' + k.replace(/index\.html$/, '')));  // "/trip/kandy-to-ella/"

  const out = new Map();
  for (const { from, to } of map) {
    // Integrity: any /trip/<slug>/ target must be a real generated route page.
    if (/^\/trip\/.+\//.test(to) && !routeTargets.has(to)) {
      throw new Error(`redirect target ${to} (from ${from}) has no generated route page`);
    }
    out.set(stubPath(from), stubHtml(to));
  }

  // Cloudflare Bulk Redirects CSV: positional columns, NO header row
  // (developers.cloudflare.com/rules/url-forwarding/bulk-redirects/reference/csv-file-format/).
  // Scheme-less sources match both http and https in one hop, per Cloudflare's examples.
  const HOST = ORIGIN.replace(/^https?:\/\//, '');
  const csv = map.map(({ from, to }) => `${HOST}${from},${ORIGIN}${to},301`).join('\n') + '\n';
  out.set('docs/cloudflare-redirects.csv', csv);
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  let n = 0;
  for (const [rel, content] of generateRedirects()) {
    const abs = join(ROOT, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
    n++;
  }
  console.log(`generated ${n} redirect artifacts`);
}
