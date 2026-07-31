import { describe, it, expect } from 'vitest';
import { createApp } from '../app';

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
      ['/phone-countries.js', 'javascript'],
      ['/analytics.js', 'javascript'],
      ['/consent.js', 'javascript'],
      ['/favicon.svg', 'image/svg+xml'],
      ['/img/ceylon-hop-touch-icon.png', 'image/png'],
    ];
    for (const [path, type] of cases) {
      const res = await get(path);
      expect(res.status, `${path} missing — the page would render unstyled/broken`).toBe(200);
      expect(res.headers.get('content-type')).toContain(type);
    }
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
