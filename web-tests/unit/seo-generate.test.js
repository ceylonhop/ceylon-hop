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
    expect(html).toContain('$53');            // car price from the rate card
    expect(html).toMatch(/"@type":\s*"FAQPage"/);
    expect(html).not.toContain('aggregateRating');
    expect(html).toContain('../../site.css'); // relative asset ref
  });
  it('CTA deep-links into search with from/to prefilled', () => {
    const html = out.get('trip/kandy-to-ella/index.html');
    expect(html).toContain('../../search.html?from=kandy&to=ella');
  });
  it('reverse page uses the back narrative and same prices', () => {
    const fwd = out.get('trip/kandy-to-ella/index.html');
    const rev = out.get('trip/ella-to-kandy/index.html');
    expect(rev).toContain('<h1>Ella to Kandy</h1>');
    expect(rev).toContain('$53'); // symmetric pricing
    expect(fwd).not.toBe(rev);
  });
  it('sitemap lists every route page with absolute apex URLs', () => {
    const xml = out.get('sitemap.xml');
    expect(xml).toContain('<loc>https://ceylonhop.com/trip/kandy-to-ella/</loc>');
    expect((xml.match(/<loc>/g) || []).length).toBeGreaterThanOrEqual(45);
  });
});
