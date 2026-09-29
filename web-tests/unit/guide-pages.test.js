// Contract for generated destination guides (spec 2026-09-28-destination-guides-design.md §6, §7, §10).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateGuides } from '../../tools/generate-guides.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';

const out = generateGuides();
const REL = 'guides/nuwara-eliya/index.html';
const html = out.get(REL);
const noJs = h => h.replace(/<script[\s\S]*?<\/script>/g, '');
const section = (h, id) => {
  const i = h.indexOf(`id="${id}"`); expect(i, `section #${id}`).toBeGreaterThan(-1);
  const j = h.indexOf('</section>', i); return h.slice(i, j);
};

describe('generateGuides', () => {
  it('emits the Nuwara Eliya guide and generateStaticPages includes it', () => {
    expect(html).toBeTruthy();
    expect(generateStaticPages().has(REL)).toBe(true);
  });
  it('carries canonical, OG, Article + FAQPage + BreadcrumbList JSON-LD', () => {
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/guides/nuwara-eliya/">');
    expect(html).toContain('property="og:url" content="https://ceylonhop.com/guides/nuwara-eliya/"');
    expect(html).toMatch(/"@type":\s*"Article"/);
    expect(html).toMatch(/"@type":\s*"FAQPage"/);
    expect(html).toMatch(/"@type":\s*"BreadcrumbList"/);
    expect(html).toContain('Is Nuwara Eliya worth visiting?');
  });
  it('ships the site chrome without JavaScript (header, footer, route index link)', () => {
    const h = noJs(html);
    expect(h).toMatch(/<header class="nav/);
    expect(h).toMatch(/<footer/);
    expect(h).toMatch(/href="\.\.\/\.\.\/trip\/"/);
    expect(h).toContain('href="../../blog.html"');
  });
  it('Getting here sells the car only: no price, no train row, no tuk-tuk', () => {
    const s = section(html, 'here');
    expect(s).toContain('search.html?from=kandy&amp;to=nuwara-eliya');
    expect(s).toContain('search.html?from=ella&amp;to=nuwara-eliya');
    expect(s).toContain('search.html?from=cmb-airport&amp;to=nuwara-eliya');
    const cards = s.slice(0, s.indexOf('<details'));
    expect(cards).not.toMatch(/\$\d/);
    expect(cards.toLowerCase()).not.toContain('tuk-tuk');
    expect(cards.toLowerCase()).not.toContain('train');
    expect(s).toContain('Thinking about the train?');
  });
  it('Where next reuses the trip-page card with live-fare hooks, one card per corridor direction', () => {
    const s = section(html, 'next');
    const cards = s.match(/<a class="rt-card"/g) || [];
    expect(cards).toHaveLength(4);
    for (const href of ['trip/nuwara-eliya-to-kandy/', 'trip/nuwara-eliya-to-ella/', 'trip/kandy-to-nuwara-eliya/', 'trip/ella-to-nuwara-eliya/']) {
      expect(s).toContain(`href="../../${href}"`);
      expect(existsSync(path.join(ROOT, href, 'index.html')), href).toBe(true);
    }
    expect(s).toMatch(/<b data-list-fare data-from-name="Nuwara Eliya" data-to-name="Ella">\$\d/);
    expect(html).toContain('route-list-fares.js?v=');
    expect(html).toContain('list-fares-pending');
  });
  it('the Day 1 card has no booking button; Day 2 books Nuwara Eliya → Ella in the planner', () => {
    const s = section(html, 'plan');
    expect((s.match(/Book this day with us/g) || []).length).toBe(1);
    expect(s).toContain('plan.html?stops=Nuwara+Eliya%7CElla&amp;nights=0%2C0');
  });
  it('collectors and offers go to WhatsApp with a prefilled message', () => {
    expect(html).toMatch(/https:\/\/wa\.me\/94779669662\?text=[^"]*Nuwara/);
    expect(html).not.toContain('<input');
    expect(html).not.toContain('Check availability');
  });
  it('every relative href/src resolves to a file in the repo', () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map(m => m[1])
      .filter(u => !/^(https?:|mailto:|tel:|javascript:)/.test(u));
    expect(refs.length).toBeGreaterThan(20);
    for (const u of refs) {
      const clean = u.split('?')[0];
      const abs = path.resolve(path.join(ROOT, 'guides/nuwara-eliya'), clean);
      const ok = existsSync(abs) || existsSync(path.join(abs, 'index.html'));
      expect(ok, `${u} → ${abs}`).toBe(true);
    }
  });
  it('is in the sitemap', () => {
    expect(generateAll().get('sitemap.xml')).toContain('<loc>https://ceylonhop.com/guides/nuwara-eliya/</loc>');
  });
  it('the committed page equals the generator output (run npm run generate if this fails)', () => {
    expect(readFileSync(path.join(ROOT, REL), 'utf8')).toBe(html);
  });
  it('blog.html links the guide in static HTML (crawlable without JS)', () => {
    const blog = readFileSync(path.join(ROOT, 'blog.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
    expect(blog).toContain('href="guides/nuwara-eliya/"');
    expect(blog).toContain('src="img/guides/nuwara-eliya/hero-900.jpg"');
  });
  it("shared links unfurl with the guide's own hero image, not the site-wide cover", () => {
    const img = 'https://ceylonhop.com/img/guides/nuwara-eliya/og.jpg';
    expect(html).toContain(`<meta property="og:image" content="${img}">`);
    expect(html).toContain('<meta property="og:image:width" content="1200">');
    expect(html).toContain('<meta property="og:image:height" content="630">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).toContain(`<meta name="twitter:image" content="${img}">`);
    expect(html).not.toContain('og-cover.jpg');
  });
});
