import { Hono } from 'hono';
import { compress } from 'hono/compress';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The Control Tower ops UI, served same-origin so it can call /admin/ops/* with the
// ch_ops session cookie and no CORS. The raw file is cached after the first successful
// read; a missing/unreadable file serves a minimal unavailable body rather than a bare
// 500 stack. The Google OAuth client id (not a secret), the dev-login-enabled flag and
// the browser Maps key are templated in — see uiHtml() for why that happens once.
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

// Same three substitutions, computed once instead of on every page load. The inputs are fixed
// when the router is built, so the result cannot vary between requests — but the shell is ~650KB,
// so running three replaceAll passes over it per request allocated several megabytes each time,
// for a string that is byte-identical every time.
//
// Memoised on SUCCESS only, deliberately mirroring rawHtml(): an unreadable file must stay
// retryable on the next request rather than latching the "unavailable" body in for the life of
// the process. Both mounts (/ops and "/") share one router instance, so they share this too.
function memoUiHtml(googleClientId: string, devLoginEnabled: boolean, mapsBrowserKey: string): () => string | null {
  let cached: string | null = null;
  return () => (cached ??= uiHtml(googleClientId, devLoginEnabled, mapsBrowserKey));
}

// Mounted at BOTH /ops and the bare root "/" (so ops.ceylonhop.com serves the tool, not only
// /ops). Compression is route-level here — not an app.use('/ops') in app.ts — so it travels
// with the router to whichever path(s) it's mounted at, and never leaks onto the JSON API.
// The ~190KB shell gzips to ~40KB on the wire; Hono's compress only fires when the request
// sends Accept-Encoding: gzip/deflate, so non-gzip clients still get the raw HTML.
export function opsUiRoutes(googleClientId = '', devLoginEnabled = false, mapsBrowserKey = ''): Hono {
  const app = new Hono();
  const html = memoUiHtml(googleClientId, devLoginEnabled, mapsBrowserKey);
  app.get('/', compress(), (c) => {
    const body = html();
    if (body == null) return c.html('<h1>ops dashboard unavailable</h1>', 500);
    return c.html(body);
  });
  return app;
}
