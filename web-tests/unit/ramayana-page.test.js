// Contract for the generated Ramayana trail page (tools/ramayana/trail.json → ramayana-trail-sri-lanka/).
// Owner calls (2026-10-17): no placeholder trust items, stand-in photos labelled "Illustrative",
// fixed "from" prices from the ops-tool quotes, and no service promises the team hasn't confirmed.
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateRamayana, loadRamayana, RAMAYANA_PATH, perPerson } from '../../tools/generate-ramayana.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateAll, ROOT, SITEMAP_EXTRA } from '../../tools/generate-route-pages.mjs';

const REL = `${RAMAYANA_PATH}index.html`;
const html = generateRamayana().get(REL);
const r = loadRamayana();
const noJs = h => h.replace(/<script[\s\S]*?<\/script>/g, '');
const ld = type => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(m => JSON.parse(m[1])).flatMap(o => o['@graph'] || [o]).filter(o => o['@type'] === type);

/** Real pixel size from a JPEG's SOF marker (same reader as guide-content.test.js). */
function jpegSize(file) {
  const b = readFileSync(file);
  let i = 2;
  while (i < b.length) {
    if (b[i] !== 0xff) { i++; continue; }
    const m = b[i + 1], len = b.readUInt16BE(i + 2);
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return { width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    i += 2 + len;
  }
  throw new Error(`no SOF in ${file}`);
}

describe('generateRamayana', () => {
  it('emits the page and generateStaticPages includes it', () => {
    expect(html).toBeTruthy();
    expect(generateStaticPages().has(REL)).toBe(true);
  });
  it('is indexable: title, canonical, OG image, no noindex', () => {
    expect(html).toContain('<title>Ramayana Tour in Sri Lanka: Private-Car Trail, Itineraries &amp; Prices</title>');
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/ramayana-trail-sri-lanka/">');
    expect(html).toContain('<meta property="og:image" content="https://ceylonhop.com/img/ramayana/og.jpg">');
    expect(html).not.toMatch(/name="robots" content="noindex/);
  });
  it('h1 carries the commercial term', () => {
    expect(html).toContain('<h1>Ramayana Tour in Sri Lanka</h1>');
  });
  it('ships the site chrome without JavaScript', () => {
    const h = noJs(html);
    expect(h).toMatch(/<header class="nav/);
    expect(h).toMatch(/<footer/);
    expect(h).toContain('href="../blog.html"');
  });
  it('structured data: breadcrumb, one TouristTrip per trip with its stops, FAQPage matching the visible questions', () => {
    expect(ld('BreadcrumbList')[0].itemListElement.map(x => x.name)).toEqual(['Home', 'Travel Guide', 'Ramayana Tour in Sri Lanka']);
    const trips = ld('TouristTrip');
    expect(trips.map(t => t.name)).toEqual(r.trips.map(t => t.name));
    for (const t of trips) expect(t.itinerary.itemListElement.length).toBeGreaterThan(4);
    const visible = [...html.matchAll(/<summary>([\s\S]*?)<\/summary>/g)].length;
    expect(ld('FAQPage')[0].mainEntity).toHaveLength(visible);
    expect(visible).toBe(r.faq.reduce((n, g) => n + g.items.length, 0));
  });
  it('shows the ops-tool prices and splits them per person from the car and van totals', () => {
    for (const t of r.trips) {
      expect(html).toContain(`$${t.price.car} per car`);
      expect(html).toContain(`$${perPerson(t.price.car, 2)} each for 2`);
      expect(html).toContain(`Van for up to 6: $${t.price.van} ($${perPerson(t.price.van, 6)} each for 6)`);
    }
    expect(perPerson(445, 2)).toBe(223);
    expect(perPerson(495, 6)).toBe(83);
    expect(html).toContain(`from $${Math.min(...r.trips.map(t => t.price.car))} <span class="unit">per car</span>`);
  });
  it('ships nothing unfinished: no placeholders, no blank prices, no unresolved fare tokens', () => {
    expect(html).not.toMatch(/placeholder/i);
    expect(html).not.toContain('$—');
    expect(html).not.toContain('{fare:');
    expect(html).not.toMatch(/Sample page/i);
  });
  it('labels every stand-in photo as illustrative', () => {
    const stand = Object.entries(r.photos).filter(([, m]) => m.illustrative).map(([k]) => k);
    expect(stand.length).toBeGreaterThan(0);
    for (const k of stand) {
      const i = html.indexOf(`img/ramayana/${k}-900.jpg`);
      expect(i, k).toBeGreaterThan(-1);
      expect(html.slice(i, i + 900), k).toContain('Illustrative photo');
    }
  });
  it('respects both readings of Ravana: never calls him a demon', () => {
    expect(html.toLowerCase()).not.toContain('demon');
  });
  it('is in the sitemap and linked from the Travel Guide hub', () => {
    expect(SITEMAP_EXTRA).toContain(RAMAYANA_PATH);
    expect(generateAll().get('sitemap.xml')).toContain(`https://ceylonhop.com/${RAMAYANA_PATH}`);
    expect(readFileSync(path.join(ROOT, 'blog.html'), 'utf8')).toContain(`href="${RAMAYANA_PATH}"`);
  });
  it('the committed page equals the generator output (run npm run generate if this fails)', () => {
    expect(readFileSync(path.join(ROOT, REL), 'utf8')).toBe(html);
  });
});

describe('ramayana content', () => {
  it('every photo exists at 900 and 1800, declares its real size, and is credited', () => {
    const credits = readFileSync(path.join(ROOT, 'credits.html'), 'utf8');
    for (const [k, m] of Object.entries(r.photos)) {
      for (const size of [900, 1800]) expect(existsSync(path.join(ROOT, 'img/ramayana', `${k}-${size}.jpg`)), `${k}-${size}`).toBe(true);
      expect(jpegSize(path.join(ROOT, 'img/ramayana', `${k}-1800.jpg`)), k).toEqual({ width: m.w, height: m.h });
      expect(m.alt, `${k}.alt`).toBeTruthy();
      expect(m.creditUrl, `${k}.creditUrl`).toMatch(/^https:\/\/unsplash\.com\//);
      expect(credits, `${k} → ${m.credit}`).toContain(m.creditUrl);
    }
  });
  it('has a 1200×630 share image under 300 KB', () => {
    const f = path.join(ROOT, 'img/ramayana/og.jpg');
    expect(jpegSize(f)).toEqual({ width: 1200, height: 630 });
    expect(readFileSync(f).length).toBeLessThan(300 * 1024);
  });
  it('title and description fit the SERP', () => {
    expect(r.title.length).toBeLessThanOrEqual(70);
    expect(r.description.length).toBeLessThanOrEqual(160);
  });
});
