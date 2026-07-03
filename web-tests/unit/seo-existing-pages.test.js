import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

// Self-canonical target per existing page (index → apex root; tour → the indexed
// tours.html since tour.html is a param-driven template).
const CANON = {
  'index.html': 'https://ceylonhop.com/',
  'about.html': 'https://ceylonhop.com/about.html',
  'blog.html': 'https://ceylonhop.com/blog.html',
  'plan.html': 'https://ceylonhop.com/plan.html',
  'tours.html': 'https://ceylonhop.com/tours.html',
  'why.html': 'https://ceylonhop.com/why.html',
  'search.html': 'https://ceylonhop.com/search.html',
  'booking.html': 'https://ceylonhop.com/booking.html',
  'tour.html': 'https://ceylonhop.com/tours.html',
};
const INDEXED = ['index.html', 'about.html', 'blog.html', 'plan.html', 'tours.html', 'why.html'];
const NOINDEX = ['search.html', 'booking.html', 'tour.html'];

describe('existing-page head metadata (M16 PR3)', () => {
  it('every page carries the correct self-canonical', () => {
    for (const [file, canon] of Object.entries(CANON)) {
      expect(read(file), file).toContain(`<link rel="canonical" href="${canon}">`);
    }
  });
  it('param-driven templates are noindex; content pages are indexable', () => {
    for (const f of NOINDEX) expect(read(f), f).toMatch(/name="robots"[^>]*noindex/);
    for (const f of INDEXED) expect(read(f), f).not.toMatch(/noindex/);
  });
  it('every page has Open Graph url + site_name', () => {
    for (const f of Object.keys(CANON)) {
      const h = read(f);
      expect(h, `${f} og:url`).toMatch(/property="og:url"/);
      expect(h, `${f} og:site_name`).toContain('property="og:site_name" content="Ceylon Hop"');
    }
  });
  it('no aggregateRating, no stale 4.9, and no 600-count rating claim anywhere', () => {
    for (const f of ['index.html', 'booking.html']) {
      const h = read(f);
      expect(h, `${f} aggregateRating`).not.toContain('aggregateRating');
      expect(h, `${f} 4.9`).not.toContain('4.9');
      // catches "600+ happy hoppers", "600+ reviews", "600 travellers" — but not font-weight:600
      expect(h, `${f} 600 claim`).not.toMatch(/600\+|600\s*(reviews|travellers|happy)/i);
    }
  });
  it('every Tripadvisor link on the homepage points at the real listing (no bare homepage link)', () => {
    const h = read('index.html');
    expect(h, 'bare tripadvisor homepage link').not.toMatch(/href="https:\/\/www\.tripadvisor\.com\/"/);
    // hero badge + reviews pill + JSON-LD sameAs
    expect((h.match(/tripadvisor\.com\/Attraction_Review-g3736162-d33018957/g) || []).length).toBeGreaterThanOrEqual(3);
  });
  it('homepage declares a real og:image for social shares', () => {
    expect(read('index.html')).toContain('property="og:image" content="https://ceylonhop.com/og-cover.jpg"');
  });
  it('homepage JSON-LD links to the real Tripadvisor listing via sameAs', () => {
    const h = read('index.html');
    expect(h).toMatch(/"sameAs":\s*\[/);
    expect(h).toContain('tripadvisor.com/Attraction_Review-g3736162-d33018957');
  });
  it('the corrected rating (5.0 / 30) shows in visible copy', () => {
    expect(read('index.html')).toContain('30 reviews');
    expect(read('booking.html')).toContain('from 30 travellers on Tripadvisor');
  });
});
