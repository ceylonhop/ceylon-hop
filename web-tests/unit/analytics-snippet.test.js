import { describe, it, expect } from 'vitest';
import { headAssets, analyticsSnippet } from '../../tools/site-chrome.mjs';

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
