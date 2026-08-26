import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

/* Internal pages must never be indexable. The API-served ops dashboard already sends both an
   X-Robots-Tag header and a robots meta, but a STATIC ops page deployed to Pages has neither
   unless it says so itself — and `_ops-preview.html` shipped to the public webroot carrying
   sample coordinator names and phone numbers with no robots meta at all. Unlinked is not the
   same as unindexable: a sitemap slip, an inbound link or a URL in someone's history is enough.

   Note this is deliberately a NOINDEX rule and not a robots.txt Disallow — a disallowed page
   cannot be crawled, so the crawler never sees the noindex and the URL can still surface.
   robots.txt in this repo carries the same reasoning for the param pages. */
const opsPages = readdirSync(root)
  .filter((f) => f.endsWith('.html') && /^_?ops/i.test(f));

describe('internal ops pages are not indexable', () => {
  it('finds the ops pages it is meant to be guarding', () => {
    // If this repo ever stops shipping a static ops page the rule is moot — but a typo in the
    // glob must not silently turn this whole suite into a no-op that passes forever.
    expect(opsPages.length).toBeGreaterThan(0);
  });

  it.each(opsPages)('%s declares noindex', (file) => {
    const html = readFileSync(path.join(root, file), 'utf8');
    const robots = /<meta\s+name="robots"\s+content="([^"]*)"/i.exec(html);
    expect(robots, `${file} has no <meta name="robots">`).toBeTruthy();
    expect(robots[1].toLowerCase()).toContain('noindex');
  });
});
