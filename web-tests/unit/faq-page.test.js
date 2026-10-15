// Contract for the generated travel FAQ (spec 2026-10-14-sri-lanka-travel-faq-design.md §4–§8, §12).
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { generateFaq, renderFaq, resolveFares, loadFaq, FAQ_PATH } from '../../tools/generate-faq.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';
import { generateStaticPages } from '../../tools/generate-static-pages.mjs';
import { generateAll, ROOT } from '../../tools/generate-route-pages.mjs';

const REL = `${FAQ_PATH}index.html`;
const html = generateFaq().get(REL);
const f = loadFaq();
const T = loadTransfers();
const noJs = h => h.replace(/<script[\s\S]*?<\/script>/g, '');
const section = (h, id) => {
  const i = h.indexOf(`<section class="topic" id="${id}"`); expect(i, `topic #${id}`).toBeGreaterThan(-1);
  const j = h.indexOf('</section>', i); return h.slice(i, j);
};
const ld = type => [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
  .map(m => JSON.parse(m[1])).find(o => o['@type'] === type);

describe('generateFaq', () => {
  it('emits the page and generateStaticPages includes it', () => {
    expect(html).toBeTruthy();
    expect(generateStaticPages().has(REL)).toBe(true);
  });
  it('carries title, canonical, OG image, Article + FAQPage + BreadcrumbList', () => {
    expect(html).toContain('<title>Sri Lanka travel FAQ — visas, money, trains, safaris</title>');
    expect(html).toContain('<link rel="canonical" href="https://ceylonhop.com/sri-lanka-travel-faq/">');
    expect(html).toContain('<meta property="og:image" content="https://ceylonhop.com/img/faq/og.jpg">');
    expect(ld('Article').dateModified).toBe(f.updated);
    expect(ld('BreadcrumbList').itemListElement.map(x => x.name)).toEqual(['Home', 'Travel Guide', 'Sri Lanka travel FAQ']);
    const qa = f.topics.filter(t => t.shape === 'qa').reduce((n, t) => n + t.items.length, 0);
    const cmp = f.topics.filter(t => t.shape === 'compare').length;
    expect(ld('FAQPage').mainEntity).toHaveLength(qa + cmp);
    expect(ld('FAQPage').mainEntity.map(q => q.name)).toContain('Which safari park should you pick?');
    expect(ld('FAQPage').mainEntity.every(q => q.acceptedAnswer.text.length > 20)).toBe(true);
    const apply = ld('FAQPage').mainEntity.find(q => q.name === 'What are the official ways to apply?');
    expect(apply.acceptedAnswer.text).toContain('channels: Yourself, online');
  });
  it('ships the site chrome without JavaScript (header, footer, route index link)', () => {
    const h = noJs(html);
    expect(h).toMatch(/<header class="nav/);
    expect(h).toMatch(/<footer/);
    expect(h).toMatch(/href="\.\.\/trip\/"/);
    expect(h).toContain('href="../blog.html"');
  });
  it('banner: h1, breadcrumb, computed answer count and long updated date', () => {
    expect(html).toContain('<h1>Sri Lanka travel FAQ</h1>');
    expect(html).toContain('<span class="bc-cur" aria-current="page">Travel FAQ</span>');
    const qa = f.topics.filter(t => t.shape === 'qa').reduce((n, t) => n + t.items.length, 0);
    const cmp = f.topics.filter(t => t.shape === 'compare').length;
    expect(html).toContain(`${qa + cmp} answers · Updated 14 October 2026`);
  });
  it('index lists every topic in order with a count, and every entry targets a section', () => {
    const idx = html.slice(html.indexOf('<aside class="f-index" id="topics"'), html.indexOf('</aside>'));
    const ids = [...idx.matchAll(/href="#([a-z-]+)"/g)].map(m => m[1]);
    expect(ids).toEqual(f.topics.map(t => t.id));
    for (const id of ids) expect(html).toContain(`<section class="topic" id="${id}"`);
    expect(idx).toContain('<span class="c">4 parks</span>');
    expect(idx).toContain(`<span class="c">${f.topics[0].items.length}</span>`);
  });
  it('only the first question is open; every question has a stable anchor and a copy-link button', () => {
    expect(html.match(/<details[^>]*\sopen/g)).toHaveLength(1);
    expect(html).toMatch(/<details id="visa-how-to-get" open>/);
    for (const t of f.topics) for (const q of t.items || []) {
      expect(html).toContain(`<details id="${t.id}-${q.id}"`);
      expect(html).toContain(`data-link="https://ceylonhop.com/sri-lanka-travel-faq/#${t.id}-${q.id}"`);
    }
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    expect(new Set(ids).size).toBe(ids.length);
    const css = html.match(/<style>([\s\S]*?)<\/style>/)[1];
    expect(css).toMatch(/\.topic details\{[^}]*scroll-margin-top:84px/);
  });
  it('callouts use only the two kinds, with the guides\' labels', () => {
    expect(html).toContain('<div class="tip warn"><b>Good to know</b>');
    expect(html).toContain('<div class="tip"><b>Our tip</b>');
    expect(html).not.toMatch(/<b>(Careful|From our drivers)<\/b>/);
  });
  it('"checked" renders only where the JSON has it, with the long date', () => {
    const dated = f.topics.flatMap(t => (t.items || []).filter(q => q.checked)).length + f.topics.filter(t => t.checked).length;
    expect(html.match(/<span class="chk">/g)).toHaveLength(dated);
    expect(html).toContain('<span class="chk">Rules checked 9 October 2026</span>');
    expect(section(html, 'money')).toContain('Rate checked 9 October 2026');
    expect(section(html, 'culture')).not.toContain('Poya checked');
  });
  it('resolves every {fare:…} token from the catalogue and leaves none behind', () => {
    expect(html).not.toContain('{fare:');
    const shared = T.sharedOption('cmb-airport', 'sigiriya').seat;
    expect(section(html, 'money')).toContain(`Colombo Airport to Sigiriya is $${shared.toFixed(2)} a seat`);
    expect(section(html, 'money')).toContain(`start around $${T.privateQuote('galle', 'mirissa').car}`);
    expect(() => resolveFares('{fare:kandy:nowhere:private}', T)).toThrow(/nowhere/);
    expect(() => resolveFares('{fare:kandy:galle:shared}', T)).toThrow(/no shared/);
    expect(() => resolveFares('{fare:kandy:galle}', T)).toThrow(/malformed/);
  });
  it('offer rows reuse the guides\' .ch-row and point where the JSON says', () => {
    const around = section(html, 'around');
    expect(around).toContain('<a class="ch-row" href="../search.html?from=kandy&amp;to=nuwara-eliya">');
    expect(around).toContain('<span class="arr">See price &amp; book →</span>');
    const start = section(html, 'start');
    expect(start).toMatch(/<a class="ch-row" href="https:\/\/wa\.me\/94779669662\?text=[^"]*limited%20mobility/);
    expect(html.match(/<a class="ch-row"/g).length).toBe(f.topics.flatMap(t => (t.items || []).filter(q => q.offer)).length);
  });
  it('comparison topics are answer-first: photo, pick box, then text-only cards', () => {
    const s = section(html, 'safaris');
    const photo = s.indexOf('img/faq/safaris-900.jpg'), pick = s.indexOf('<div class="pick">'), cards = s.indexOf('<div class="cmp">');
    expect(photo).toBeGreaterThan(-1);
    expect(pick).toBeGreaterThan(photo);
    expect(cards).toBeGreaterThan(pick);
    expect(s.match(/<div class="cc">/g)).toHaveLength(4);
    expect(s.slice(cards)).not.toContain('<img');
    expect(s).toContain('<dt>Crowds</dt>');
    expect(s).toContain('href="../guides/sigiriya/"');
    expect(section(html, 'beaches')).toContain('href="../guides/mirissa/"');
  });
  it('the band and pill are present; the band is the only generic WhatsApp prompt', () => {
    expect(html).toContain('<h2>Still wondering?</h2>');
    expect(html).toContain(`text=${encodeURIComponent(f.ask.wa)}`);
    expect(html).toContain('<a class="pill" id="pill" href="#topics">');
    expect(html).toContain('faq-page.js?v=');
  });
  it('every relative href/src resolves to a file in the repo', () => {
    const refs = [...html.matchAll(/\b(?:href|src)="([^"#]+)(?:#[^"]*)?"/g)].map(m => m[1])
      .filter(u => !/^(https?:|mailto:|tel:|javascript:)/.test(u));
    expect(refs.length).toBeGreaterThan(20);
    for (const u of refs) {
      const abs = path.resolve(path.join(ROOT, FAQ_PATH), u.split('?')[0]);
      expect(existsSync(abs) || existsSync(path.join(abs, 'index.html')), `${u} → ${abs}`).toBe(true);
    }
  });
  it('is in the sitemap', () => {
    expect(generateAll().get('sitemap.xml')).toContain('<loc>https://ceylonhop.com/sri-lanka-travel-faq/</loc>');
  });
  it('the committed page equals the generator output (run npm run generate if this fails)', () => {
    expect(readFileSync(path.join(ROOT, REL), 'utf8')).toBe(html);
  });
  it('a topic with no items is neither rendered nor indexed', () => {
    const g = structuredClone(f);
    g.topics[1].items = [];
    const h = renderFaq(g, T);
    expect(h).not.toContain('<section class="topic" id="before"');
    expect(h).not.toContain('href="#before"');
  });
});
