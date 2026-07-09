import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateRedirects } from '../../tools/generate-redirects.mjs';

// Guards against drift: every committed generated file must equal what the
// generators produce from the current data/content. If this fails: `npm run generate`.
const everything = new Map([
  ...generateAll(),        // 44 route pages + /trip/ index + sitemap.xml
  ...generateStaticPages(), // terms.html, privacy.html, 404.html
  ...generateRedirects(),   // 32 redirect stubs + docs/cloudflare-redirects.csv
]);

describe('generated files match the generators (no drift)', () => {
  for (const [rel, content] of everything) {
    it(rel, () => {
      let onDisk;
      try { onDisk = readFileSync(join(ROOT, rel), 'utf8'); }
      catch { throw new Error(`missing generated file ${rel} — run: npm run generate`); }
      expect(onDisk).toBe(content);
    });
  }
});

// Bookings now charge the full amount online (deposits were removed). No generated
// customer-facing page (visible FAQ or FAQPage JSON-LD) may still promise a deposit.
describe('generated pages match the pay-in-full policy (no deposit promises)', () => {
  const tripPages = [...everything].filter(([rel]) => /^trip\/.+\/index\.html$/.test(rel));
  it('covers the trip pages', () => { expect(tripPages.length).toBeGreaterThanOrEqual(44); });
  for (const [rel, content] of tripPages) {
    it(`${rel} makes no deposit promise`, () => {
      expect(content).not.toContain('small deposit');
      expect(content).not.toContain('deposit to confirm');
      expect(content).not.toContain('balance to your driver');
    });
  }
  it('the route-page booking FAQ tells customers they pay online', () => {
    const kandy = everything.get('trip/cmb-airport-to-kandy/index.html');
    expect(kandy).toContain('pay securely online to confirm');
  });
});
