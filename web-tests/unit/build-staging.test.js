// web-tests/unit/build-staging.test.js
// tools/build-staging.mjs assembles the copy of the site that Cloudflare Pages serves at
// staging.ceylonhop.com. Its whole job is to make the staged site talk to the STAGING api
// instead of prod, so a test booking there can never reach a real customer or a real card.
//
// The invariant is positional, not textual: every page keeps its own
// `window.CEYLON_HOP_API || 'https://ceylon-hop-api.onrender.com'` fallback (board.html
// falls back to ops.ceylonhop.com), and we do not strip it. We set the variable BEFORE that
// line runs, so the `||` keeps our value. A build that injects the assignment after the
// page's own script would look correct to a grep and point the whole staged site at prod.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { stampHtml, buildStaging, STAGING_API } from '../../tools/build-staging.mjs';

const PROD_HOSTS = ['ceylon-hop-api.onrender.com', 'ops.ceylonhop.com'];

describe('stampHtml', () => {
  const page = '<!doctype html><html><head><meta charset="utf-8">'
    + '<script>window.CEYLON_HOP_API=window.CEYLON_HOP_API||"https://ceylon-hop-api.onrender.com"</script>'
    + '</head><body>hi</body></html>';

  it('sets the staging API base before the page\'s own script runs', () => {
    const out = stampHtml(page);
    expect(out).toContain(STAGING_API);
    expect(out.indexOf(STAGING_API)).toBeLessThan(out.indexOf('ceylon-hop-api.onrender.com'));
  });

  it('marks the page noindex', () => {
    expect(stampHtml(page)).toMatch(/<meta name="robots" content="noindex">/);
  });

  it('is idempotent — a second pass injects nothing more', () => {
    const once = stampHtml(page);
    expect(stampHtml(once)).toBe(once);
  });

  it('refuses a page with no <head> rather than shipping it unstamped', () => {
    expect(() => stampHtml('<html><body>no head</body></html>')).toThrow(/head/i);
  });

  it('handles <head> carrying attributes', () => {
    const out = stampHtml('<html><head lang="en"><script>0</script></head></html>');
    expect(out.indexOf(STAGING_API)).toBeLessThan(out.indexOf('<script>0</script>'));
  });
});

describe('buildStaging', () => {
  const dest = mkdtempSync(path.join(tmpdir(), 'ch-staging-'));
  buildStaging(dest);

  const htmlFiles = [];
  (function walk(dir) {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else if (entry.endsWith('.html')) htmlFiles.push(full);
    }
  })(dest);

  it('produces the whole site, not a handful of pages', () => {
    expect(htmlFiles.length).toBeGreaterThan(50);
  });

  it('points every built page at staging ahead of any prod host it mentions', () => {
    const offenders = [];
    for (const file of htmlFiles) {
      const html = readFileSync(file, 'utf8');
      const staged = html.indexOf(STAGING_API);
      if (staged === -1) { offenders.push(`${path.relative(dest, file)}: no staging base`); continue; }
      for (const host of PROD_HOSTS) {
        const prod = html.indexOf(host);
        if (prod !== -1 && prod < staged) offenders.push(`${path.relative(dest, file)}: ${host} precedes it`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('tells crawlers to stay out, belt and braces with Cloudflare Access', () => {
    expect(readFileSync(path.join(dest, 'robots.txt'), 'utf8')).toMatch(/Disallow: \/\s*$/);
  });

  it('leaves the api, docs and test trees out of the published site', () => {
    const top = readdirSync(dest);
    expect(top).not.toContain('api');
    expect(top).not.toContain('docs');
    expect(top).not.toContain('web-tests');
    expect(top).not.toContain('node_modules');
  });
});
