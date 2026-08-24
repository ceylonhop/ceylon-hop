// Minimal static file server for the Ceylon Hop booking page.
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
// Default 4173 for the preview (.claude/launch.json, bare `node serve-booking.js`).
// The e2e suite overrides this per-worktree (see web-tests/static-port.js) so
// concurrent checkouts never share — and silently cross-test — one server.
const PORT = Number.parseInt(process.env.CH_STATIC_PORT ?? '', 10) > 0
  ? Number.parseInt(process.env.CH_STATIC_PORT, 10)
  : 4173;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

// ---------------------------------------------------------------------------
// Offline guard for the e2e suite.
//
// Every root page carries an inline error reporter that beacons JS errors to a HARDCODED
// production API, and it prefers navigator.sendBeacon — which page.route() cannot intercept.
// A spec that deliberately drives an error path (pay-page.spec.js pushes pay/start to
// bad_request in seven places) therefore sent REAL client_error reports to prod, and from
// there to Sentry and the founder's alert email. Only 2 of 89 specs had a hand-rolled net.
//
// The fix is structural: rewrite the DESTINATION of every request addressed to a live API
// host to this server's own origin, leaving window.CEYLON_HOP_API itself alone.
//
// Rewriting the BASE instead was tried and is wrong: ride-board-*.spec.js stubs by hostname
// predicate, so moving the base un-stubbed those specs. Rewriting the destination in-page
// keeps `window.CEYLON_HOP_API` reading exactly as before for anything that inspects it
// (share-link builders, analytics property detection).
//
// The PATH AND QUERY are preserved deliberately, so every existing route keeps matching:
// glob routes (`**/health`, `**/quote/v2/estimate`) still match, and exact-path predicates
// (`new URL(u).pathname === '/board/me'`) still match. Only a predicate keyed on the HOSTNAME
// stops matching — that is the ride-board trio, updated to accept either form.
//
// Scope: fetch + sendBeacon. No root page uses XMLHttpRequest.
//
// Only active when CH_TEST_OFFLINE_API=1, set by web-tests/playwright.config.js on its
// webServer. The 4173 dev preview is deliberately untouched.
//
// CAVEAT: webServer uses reuseExistingServer:true. If CH_STATIC_PORT is pinned at an
// already-running preview, Playwright reuses THAT process and this injection is absent.
const OFFLINE_API = process.env.CH_TEST_OFFLINE_API === '1';

const INJECTED = [
  '<script>(function(){',
  'var LIVE=/(^|\\.)ceylonhop\\.com$|\\.onrender\\.com$/;',
  'function local(u){try{var x=new URL(u,location.href);',
  'if(x.origin!==location.origin&&LIVE.test(x.hostname))return location.origin+x.pathname+x.search;',
  '}catch(e){}return u;}',
  'var sb=navigator.sendBeacon&&navigator.sendBeacon.bind(navigator);',
  'if(sb)navigator.sendBeacon=function(u,d){return sb(local(u),d)};',
  'var f=window.fetch;',
  "if(f)window.fetch=function(u,o){return f.call(this,(typeof u==='string')?local(u):u,o)};",
  '})();</script>',
].join('');

// Insert immediately after <head> so it precedes every inline script on the page — including
// the reporter, which captures sendBeacon/fetch at definition time.
function injectOfflineGuard(html, snippet = INJECTED) {
  const m = /<head\b[^>]*>/i.exec(html);
  if (!m) return snippet + html;
  const at = m.index + m[0].length;
  return html.slice(0, at) + snippet + html.slice(at);
}

function htmlBody(data) {
  return OFFLINE_API ? Buffer.from(injectOfflineGuard(data.toString('utf8')), 'utf8') : data;
}

// Resolve a request path to a file the way GitHub Pages does: exact file →
// directory index → extensionless ".html". Lets the e2e suite exercise clean
// URLs like /trip/kandy-to-ella/ (route pages) and old /trip/foo/ redirect stubs.
function resolve(rel) {
  const base = path.join(ROOT, path.normalize(rel));
  if (!base.startsWith(ROOT)) return null;
  const candidates = [];
  if (rel.endsWith('/')) {
    candidates.push(path.join(base, 'index.html'));
  } else if (path.extname(base)) {
    candidates.push(base);
  } else {
    candidates.push(base + '.html', path.join(base, 'index.html'));
  }
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* try next */ }
  }
  return null;
}

const server = http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = resolve(rel);
  if (!filePath) {
    // Serve the branded 404 page (GitHub Pages behaviour) when it exists.
    const notFound = path.join(ROOT, '404.html');
    fs.readFile(notFound, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(htmlBody(data));
    });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    const type = TYPES[path.extname(filePath)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type });
    res.end(path.extname(filePath) === '.html' ? htmlBody(data) : data);
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
}

module.exports = { injectOfflineGuard, INJECTED };
