import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';

describe('generateAll', () => {
  const out = generateAll();
  it('emits 44 route pages + index + sitemap', () => {
    const routes = [...out.keys()].filter(k => /^trip\/[a-z-]+-to-[a-z-]+\/index\.html$/.test(k));
    expect(routes.length).toBe(44);
    expect(out.has('trip/index.html')).toBe(true);
    expect(out.has('sitemap.xml')).toBe(true);
  });
  it('kandy-to-ella page carries engine prices, canonical, JSON-LD, no aggregateRating', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/trip/kandy-to-ella/">');
    expect(html).toContain('$59');            // finished car price from the rate card
    expect(html).toMatch(/"@type":\s*"FAQPage"/);
    expect(html).not.toContain('aggregateRating');
    expect(html).toContain('../../site.css'); // relative asset ref
  });
  it('uses the shared compact route estimate in visible copy, metadata, FAQ data and cards', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    const compact = 'Approx. 135 km · 3h 45m';
    expect((html.match(/Approx\. 135 km · 3h 45m/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('136 km');
    expect(html).not.toContain('about 4 hours');

    const index = out.get('trip/index.html');
    expect(index).toContain(`Kandy → Ella</span><span class="rt-meta">${compact} · from $59`);
  });
  // The route page used to be a signpost: it showed price CHIPS and deep-linked into
  // search.html to do the actual selling. Under design A it IS the product page — the
  // options and their prices are on it, so it books directly and never forwards.
  it('books from the page itself rather than deep-linking into search', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    expect(html).not.toContain('search.html?from=kandy&to=ella');
    // &amp; because the href is escaped — a bare & in an attribute is invalid HTML,
    // which the old hand-built search link got wrong.
    expect(html).toContain('booking.html?from=kandy&amp;to=ella');
  });
  it('reverse page uses the back narrative and same prices', () => {
    const fwd = out.get('trip/kandy-to-ella/index.html');
    const rev = out.get('trip/ella-to-kandy/index.html');
    // The squiggle replaced the word "to" VISUALLY; the phrase these pages rank for must
    // survive in the markup, so a visually-hidden " to " keeps the h1 reading "Ella to Kandy".
    expect(rev).toMatch(/<h1>Ella\b[\s\S]*?<span class="vh"> to <\/span>Kandy<\/h1>/);
    expect(rev.replace(/<[^>]+>/g, '')).toContain('Ella to Kandy');
    expect(rev).toContain('$59'); // symmetric finished pricing
    expect(fwd).not.toBe(rev);
  });
  it('sitemap lists every route page with absolute apex URLs', () => {
    const xml = out.get('sitemap.xml');
    expect(xml).toContain('<loc>https://ceylonhop.com/trip/kandy-to-ella/</loc>');
    expect((xml.match(/<loc>/g) || []).length).toBeGreaterThanOrEqual(45);
  });
});
