import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (f) => readFileSync(path.resolve(__dirname, '../..', f), 'utf8');

// The follow-along footer, on both customer link pages: quote.html since #412, pay.html since
// the owner asked for the same trust signal on payment links (2026-08-10). The markup is
// duplicated rather than shared — these two pages load different stylesheets and neither loads
// site.js — so the thing worth pinning is that the duplicates do not drift apart.
const PAGES = ['quote.html', 'pay.html'];

describe('follow-along footer on the customer link pages', () => {
  for (const page of PAGES) {
    describe(page, () => {
      const html = read(page);

      it('links both accounts', () => {
        expect(html).toContain('https://www.instagram.com/ceylonhop');
        expect(html).toContain('https://www.tiktok.com/@ceylonhop');
      });

      it('names them for a screen reader, and does not hand the opener away', () => {
        expect(html).toContain('aria-label="Ceylon Hop on Instagram"');
        expect(html).toContain('aria-label="Ceylon Hop on TikTok"');
        expect(html.match(/rel="noopener noreferrer"/g).length).toBeGreaterThanOrEqual(2);
      });

      it('sits OUTSIDE #app, which every render function replaces wholesale', () => {
        // Inside #app the footer would vanish on the expired and fetch-failed states — the two
        // where a real brand mark earns the most. Checked positionally: the footer must open
        // after the wrapper that contains #app has closed.
        expect(html.indexOf('<footer class="pp-social">')).toBeGreaterThan(html.indexOf('<div id="app">'));
        expect(html.indexOf('<footer class="pp-social">')).toBeGreaterThan(html.indexOf('</div></div>'));
      });

      it('carries no third-party script — these pages ship no consent banner for one', () => {
        expect(html).not.toContain('instagram.com/embed');
        expect(html).not.toContain('tiktok.com/embed');
      });
    });
  }

  it('the two pages point at the same accounts', () => {
    const urls = (html) => (html.match(/https:\/\/www\.(?:instagram|tiktok)\.com\/[^"]+/g) || []).sort();
    expect(urls(read('pay.html'))).toEqual(urls(read('quote.html')));
  });
});
