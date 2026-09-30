// Contract for generated destination guides (spec 2026-09-28-destination-guides-design.md §6, §7, §10).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateGuides, renderGuide, loadGuides } from '../../tools/generate-guides.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';
import { loadPlacePhotos } from '../../tools/place-photos.mjs';
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
  it('optional per-guide fields: an Effort spec row, Eat/Stay subheads, a chosen Where-next list', () => {
    const ne = loadGuides().find(g => g.slug === 'nuwara-eliya');
    const T = loadTransfers(), photos = loadPlacePhotos();
    const g = structuredClone(ne);
    g.places[0].spec.level = 'Challenging';
    Object.assign(g, { eatSub: 'Eat sub here.', staySub: 'Stay sub here.', next: ['ella'] });
    const h = renderGuide(g, T, photos);
    expect(h).toContain('<small>Effort</small><b>Challenging</b>');
    expect(section(h, 'eat')).toContain('<p>Eat sub here.</p>');
    expect(section(h, 'eat')).toContain('<p>Stay sub here.</p>');
    const next = section(h, 'next');
    expect(next.match(/<a class="rt-card"/g)).toHaveLength(1);
    expect(next).toContain('href="../../trip/nuwara-eliya-to-ella/"');
    expect(() => renderGuide({ ...g, next: ['trincomalee'] }, T, photos)).toThrow(/trincomalee/);
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

// Every guide after the first shares the same contract; the specifics each one promises are below.
const MORE = [
  { slug: 'ella', origins: ['nuwara-eliya', 'kandy', 'cmb-airport'],
    next: ['ella-to-mirissa', 'ella-to-yala', 'ella-to-arugam-bay', 'ella-to-nuwara-eliya', 'ella-to-galle', 'ella-to-kandy', 'ella-to-colombo', 'ella-to-cmb-airport'],
    book: 'plan.html?stops=Ella%7CMirissa&amp;nights=0%2C0' },
  { slug: 'sigiriya', origins: ['cmb-airport', 'kandy', 'negombo'],
    next: ['sigiriya-to-cmb-airport', 'sigiriya-to-negombo', 'sigiriya-to-kandy', 'cmb-airport-to-sigiriya', 'negombo-to-sigiriya', 'kandy-to-sigiriya'],
    book: 'plan.html?stops=Sigiriya+%2F+Dambulla%7CKandy&amp;nights=0%2C0' },
];
for (const g of MORE) {
  describe(`guide: ${g.slug}`, () => {
    const rel = `guides/${g.slug}/index.html`;
    const h = out.get(rel);
    it('is generated, committed as generated, in the sitemap and linked from blog.html', () => {
      expect(h).toBeTruthy();
      expect(generateStaticPages().has(rel)).toBe(true);
      expect(readFileSync(path.join(ROOT, rel), 'utf8')).toBe(h);
      expect(generateAll().get('sitemap.xml')).toContain(`<loc>https://ceylonhop.com/guides/${g.slug}/</loc>`);
      const blog = readFileSync(path.join(ROOT, 'blog.html'), 'utf8').replace(/<script[\s\S]*?<\/script>/g, '');
      expect(blog).toContain(`href="guides/${g.slug}/"`);
      expect(blog).toContain(`src="img/guides/${g.slug}/hero-900.jpg"`);
      expect(h).toContain(`<meta property="og:image" content="https://ceylonhop.com/img/guides/${g.slug}/og.jpg">`);
    });
    it('Getting here sells the car only, from the right places', () => {
      const s = section(h, 'here');
      for (const o of g.origins) expect(s).toContain(`search.html?from=${o}&amp;to=${g.slug}`);
      const cards = s.slice(0, s.indexOf('<details'));
      expect(cards).not.toMatch(/\$\d/);
      expect(cards.toLowerCase()).not.toMatch(/train|tuk-tuk/);
    });
    it('Where next shows exactly the promised routes, in order, and each trip page exists', () => {
      const s = section(h, 'next');
      const hrefs = [...s.matchAll(/<a class="rt-card" href="\.\.\/\.\.\/trip\/([^/]+)\/"/g)].map(m => m[1]);
      expect(hrefs).toEqual(g.next);
      for (const t of hrefs) expect(existsSync(path.join(ROOT, 'trip', t, 'index.html')), t).toBe(true);
    });
    it('only the onward day books, and it preloads the planner', () => {
      const s = section(h, 'plan');
      expect((s.match(/Book this day with us/g) || []).length).toBe(1);
      expect(s).toContain(g.book);
    });
    it('every relative href/src resolves to a file in the repo', () => {
      const refs = [...h.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map(m => m[1])
        .filter(u => !/^(https?:|mailto:|tel:|javascript:)/.test(u));
      for (const u of refs) {
        const abs = path.resolve(path.join(ROOT, `guides/${g.slug}`), u.split('?')[0]);
        expect(existsSync(abs) || existsSync(path.join(abs, 'index.html')), `${u} → ${abs}`).toBe(true);
      }
    });
  });
}
