import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { injectOfflineGuard } = require_('../../serve-booking.js');
const ROOT = path.resolve(__dirname, '../..');

// Guards the offline injection in serve-booking.js. Every root page beacons JS errors to a
// hardcoded PRODUCTION url via navigator.sendBeacon, which page.route() cannot intercept, so
// the only reliable block is server-side and it must land before the page's own scripts.
describe('serve-booking offline API injection', () => {
  const { INJECTED } = require_('../../serve-booking.js');
  const SNIPPET = INJECTED;

  it('inserts immediately after <head>, before any page script', () => {
    const out = injectOfflineGuard('<!doctype html><html><head><script>first()</script></head>', SNIPPET);
    expect(out.indexOf(SNIPPET)).toBeGreaterThan(-1);
    expect(out.indexOf(SNIPPET)).toBeLessThan(out.indexOf('first()'));
  });

  it('rewrites BOTH transports, and only the errors path', () => {
    expect(SNIPPET).toContain('sendBeacon');   // the un-interceptable one
    expect(SNIPPET).toContain('fetch');        // the fallback the snippet also uses
    expect(SNIPPET).toContain('/errors/client');
  });

  it('leaves window.CEYLON_HOP_API alone — moving it un-stubs the ride-board specs', () => {
    expect(SNIPPET).not.toContain('CEYLON_HOP_API');
  });

  it('keeps the PATH so page.route("**/errors/client") still matches', () => {
    expect(SNIPPET).toContain('location.origin+x.pathname');
  });

  it('handles <head> with attributes, and a page with no head at all', () => {
    expect(injectOfflineGuard('<html><head lang="en">x', SNIPPET)).toContain('<head lang="en">' + SNIPPET);
    expect(injectOfflineGuard('<p>no head</p>', SNIPPET).startsWith(SNIPPET)).toBe(true);
  });

  // The real point: on every shipped page the injection must precede that page's own
  // reference to the production host, or the reporter captures prod before we override it.
  it('lands before the hardcoded production host on every root page that beacons', () => {
    const pages = fs.readdirSync(ROOT)
      .filter((f) => f.endsWith('.html'))
      .filter((f) => fs.readFileSync(path.join(ROOT, f), 'utf8').includes('/errors/client'));
    expect(pages.length).toBeGreaterThan(10); // all 16 root pages carry the reporter today

    for (const f of pages) {
      const out = injectOfflineGuard(fs.readFileSync(path.join(ROOT, f), 'utf8'), SNIPPET);
      const injectedAt = out.indexOf(SNIPPET);
      const reporterAt = out.indexOf('/errors/client', injectedAt + SNIPPET.length);
      expect(injectedAt, `${f}: injection missing`).toBeGreaterThan(-1);
      expect(injectedAt, `${f}: injection lands after the page's reporter`).toBeLessThan(reporterAt);
    }
  });
});
