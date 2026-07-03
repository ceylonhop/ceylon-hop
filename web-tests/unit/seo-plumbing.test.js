import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

describe('site plumbing', () => {
  it('robots allows crawling (no Disallow — noindex needs pages crawlable) and points at the sitemap', () => {
    const r = read('robots.txt');
    expect(r).toMatch(/User-agent:\s*\*/);
    expect(r).toMatch(/Allow:\s*\//);
    expect(r).not.toMatch(/^Disallow:/m); // a real Disallow would hide the in-page noindex from Google
    expect(r).toContain('Sitemap: https://ceylonhop.com/sitemap.xml');
  });
  it('404 page is branded, noindex, links home + /trip/, and self-heals on the github.io project path', () => {
    const h = read('404.html');
    expect(h).toContain('Ceylon Hop');
    expect(h).toMatch(/name="robots"[^>]*noindex/);
    expect(h).toContain('href="/trip/"');
    expect(h).toContain('href="/"');
    // root-absolute assets need a <base> on the github.io project path (served at any depth)
    expect(h).toContain("endsWith('github.io')");
  });
  it('terms and privacy exist, self-canonical to the apex, in site chrome', () => {
    for (const slug of ['terms', 'privacy']) {
      const h = read(`${slug}.html`);
      expect(h, slug).toContain(`<link rel="canonical" href="https://ceylonhop.com/${slug}.html">`);
      expect(h, `${slug} footer`).toContain('foot-grid');   // renderChrome footer present
      expect(h, `${slug} nav`).toContain('nav-links');       // renderChrome header present
      expect(h.length, `${slug} has real content`).toBeGreaterThan(1500);
    }
  });
  it('terms restores the real contact email (not the Cloudflare-obfuscated one)', () => {
    const h = read('terms.html');
    expect(h).toContain('hello@ceylonhop.com');
    expect(h).not.toContain('[email');
    expect(h).not.toMatch(/📧|📱/);
  });
  it('sitemap includes terms and privacy', () => {
    const xml = read('sitemap.xml');
    expect(xml).toContain('<loc>https://ceylonhop.com/terms.html</loc>');
    expect(xml).toContain('<loc>https://ceylonhop.com/privacy.html</loc>');
  });
});
