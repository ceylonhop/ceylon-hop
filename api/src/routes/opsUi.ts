import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Control Tower ops UI, served same-origin so it can call /admin/ops/* with the
// ch_ops session cookie and no CORS. The raw file is cached after the first successful
// read; a missing/unreadable file serves a minimal unavailable body rather than a bare
// 500 stack. The Google OAuth client id (not a secret) and the dev-login-enabled flag
// are templated into the cached raw HTML per-request — cheap string replaces, not a
// second file read.
let cachedRaw: string | null = null;
function rawHtml(): string | null {
  if (cachedRaw) return cachedRaw;
  try {
    cachedRaw = readFileSync(fileURLToPath(new URL('./ops-ui.html', import.meta.url)), 'utf8');
    return cachedRaw;
  } catch (e) {
    console.error('opsUi: failed to read ops-ui.html', e);
    return null;
  }
}

function uiHtml(googleClientId: string, devLoginEnabled: boolean, mapsBrowserKey: string): string | null {
  const raw = rawHtml();
  if (raw == null) return null;
  return raw
    .replaceAll('{{GOOGLE_CLIENT_ID}}', googleClientId)
    .replaceAll('{{DEV_LOGIN_ENABLED}}', String(devLoginEnabled))
    .replaceAll('{{MAPS_KEY}}', mapsBrowserKey);
}

// Mounted at BOTH /ops and the bare root "/" (so ops.ceylonhop.com serves the tool, not only
// /ops). Compression is route-level here — not an app.use('/ops') in app.ts — so it travels
// with the router to whichever path(s) it's mounted at, and never leaks onto the JSON API.
// The ~190KB shell gzips to ~40KB on the wire; Hono's compress only fires when the request
// sends Accept-Encoding: gzip/deflate, so non-gzip clients still get the raw HTML.
export function opsUiRoutes(googleClientId = '', devLoginEnabled = false, mapsBrowserKey = ''): Hono {
  const app = new Hono();
  app.get('/', compress(), (c) => {
    const html = uiHtml(googleClientId, devLoginEnabled, mapsBrowserKey);
    if (html == null) return c.html('<h1>ops dashboard unavailable</h1>', 500);
    return c.html(html);
  });
  return app;
}
