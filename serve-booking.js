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

http.createServer((req, res) => {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/index.html';
  const filePath = resolve(rel);
  if (!filePath) {
    // Serve the branded 404 page (GitHub Pages behaviour) when it exists.
    const notFound = path.join(ROOT, '404.html');
    fs.readFile(notFound, (err, data) => {
      if (err) { res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found'); return; }
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }).end(data);
    });
    return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}).listen(PORT, () => console.log(`Serving ${ROOT} on http://localhost:${PORT}`));
