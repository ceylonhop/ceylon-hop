import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { headAssets, analyticsSnippet } from '../../tools/site-chrome.mjs';
const ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
// The 10 HAND-AUTHORED pages. Generated pages (terms/privacy/404/trip/*) get the
// snippet via headAssets + `npm run generate` (Task 9b), covered by seo-codegen.
const PAGES = ['index.html','booking.html','search.html','plan.html','about.html','blog.html','why.html','tours.html','tour.html','manage.html'];

describe('analytics snippet (Phase 0)', () => {
  it('sets Consent Mode v2 defaults to denied before GTM loads', () => {
    // consent default must appear BEFORE the GTM loader in the string
    const iConsent = analyticsSnippet.indexOf("consent','default'");
    const iGtm = analyticsSnippet.indexOf('GTM-NL6K22CM');
    expect(iConsent).toBeGreaterThan(-1);
    expect(iGtm).toBeGreaterThan(-1);
    expect(iConsent).toBeLessThan(iGtm);
  });

  it('denies ad + analytics storage by default', () => {
    expect(analyticsSnippet).toContain("analytics_storage:'denied'");
    expect(analyticsSnippet).toContain("ad_storage:'denied'");
    expect(analyticsSnippet).toContain("ad_user_data:'denied'");
    expect(analyticsSnippet).toContain("ad_personalization:'denied'");
  });

  it('loads the GTM container and the analytics helper via headAssets (with path prefix)', () => {
    const out = headAssets('../');
    expect(out).toContain('GTM-NL6K22CM');
    expect(out).toContain('src="../analytics.js"');
    expect(out).toContain('src="../consent.js"');
  });

  it('carries no API secrets — only publishable IDs', () => {
    expect(analyticsSnippet).not.toMatch(/secret|token|api_secret/i);
  });
});

describe('analytics snippet present on every hand-authored root page', () => {
  it('has GTM + consent default + helper includes on all 10 pages', () => {
    for (const p of PAGES) {
      const html = read(p);
      expect(html.includes('GTM-NL6K22CM'), `${p} missing GTM`).toBe(true);
      expect(html.includes("consent','default'"), `${p} missing consent default`).toBe(true);
      expect(html.includes('analytics.js'), `${p} missing analytics.js`).toBe(true);
      expect(html.includes('consent.js'), `${p} missing consent.js`).toBe(true);
    }
  });
});
