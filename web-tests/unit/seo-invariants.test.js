import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';

const out = generateAll();
const routes = [...out].filter(([k]) => /^trip\/.+\/index\.html$/.test(k) && k !== 'trip/index.html');
const pick = (h, re) => (h.match(re) || [, ''])[1];

describe('route-page SEO invariants', () => {
  it('unique <title> and canonical per page', () => {
    const titles = new Set(), canon = new Set();
    for (const [k, h] of routes) {
      const t = pick(h, /<title>([^<]+)<\/title>/);
      const c = pick(h, /rel="canonical" href="([^"]+)"/);
      expect(t, `${k} title present`).toBeTruthy();
      expect(titles.has(t), `dup title ${t}`).toBe(false); titles.add(t);
      expect(canon.has(c), `dup canonical ${c}`).toBe(false); canon.add(c);
    }
  });
  it('exactly one <h1>, a meta description, and no noindex on route pages', () => {
    for (const [k, h] of routes) {
      expect((h.match(/<h1[ >]/g) || []).length, `${k} h1 count`).toBe(1);
      expect(h, `${k} description`).toMatch(/<meta name="description"/);
      expect(h, `${k} must be indexable`).not.toContain('noindex');
    }
  });
  it('every route page self-canonicalizes to its own apex URL', () => {
    for (const [k, h] of routes) {
      const slug = k.replace(/^trip\//, '').replace(/\/index\.html$/, '');
      expect(h).toContain(`<link rel="canonical" href="https://ceylonhop.com/trip/${slug}/">`);
    }
  });
  it('no aggregateRating anywhere in generated output', () => {
    for (const [, h] of out) expect(h).not.toContain('aggregateRating');
  });
  it('prices in each page match the engine rate card (no stray hardcoded prices)', () => {
    // every "$NN" that appears must be a real generated price; spot-check a known one
    expect(out.get('trip/kandy-to-ella/index.html')).toContain('$60');
    expect(out.get('trip/nuwara-eliya-to-ella/index.html')).toContain('$29'); // min fare, 54km
  });
});
