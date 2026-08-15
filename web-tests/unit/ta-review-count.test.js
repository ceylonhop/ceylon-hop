import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

// ta-data.js is a browser IIFE assigning window.TA — same trick as _load.js uses
// for transfers-data.js.
function loadTA() {
  // eslint-disable-next-line no-new-func
  new Function(read('ta-data.js'))();
  return window.TA;
}

// The review count used to be hand-copied into four places (two of them inside the
// same hero badge) with a comment asking humans to keep them in step. This suite is
// what keeps them in step instead: change ta-data.js and every stale copy goes red.
describe('Tripadvisor review count has one source', () => {
  it('ta-data.js publishes the count as a positive integer', () => {
    const TA = loadTA();
    expect(TA).toBeTruthy();
    expect(Number.isInteger(TA.reviews)).toBe(true);
    expect(TA.reviews).toBeGreaterThan(0);
  });

  // Any "<n> reviews" / "<n> travellers" claim in the shipped HTML.
  const CLAIM = /(\d+)\s+(?:reviews|travellers)\b/g;
  const PAGES = ['index.html', 'booking.html'];

  // Read the page the way a visitor and a screen reader do: the rendered text with
  // markup stripped (the number now sits in its own span), plus every aria-label —
  // the hero badge's label carries its own copy of the count and drifted separately.
  function claimsIn(page) {
    const html = read(page);
    const text = html.replace(/<script[\s\S]*?<\/script>/g, ' ').replace(/<[^>]+>/g, ' ');
    const labels = [...html.matchAll(/aria-label="([^"]*)"/g)].map(m => m[1]).join(' ');
    return [...`${text} ${labels}`.matchAll(CLAIM)].map(m => ({ whole: m[0], n: Number(m[1]) }));
  }

  it('every static count in the HTML matches ta-data.js', () => {
    const TA = loadTA();
    let found = 0;
    for (const page of PAGES) {
      for (const claim of claimsIn(page)) {
        found++;
        expect(claim.n, `${page}: "${claim.whole}"`).toBe(TA.reviews);
      }
    }
    // Guard the guard: a regex that matches nothing would pass silently. Four today —
    // hero badge text, hero aria-label, reviews pill, pay-page trust line.
    expect(found, 'no review-count claims found — did the markup change?').toBeGreaterThanOrEqual(4);
  });

  it('the count is still in the served HTML, not only injected by JS', () => {
    // Crawlers read the source; the spans carry the number and site.js only refreshes it.
    for (const page of PAGES) {
      expect(read(page), page).toMatch(/data-ta-count/);
    }
  });

  it('board.js reads the shared count instead of keeping its own', () => {
    const src = read('board.js');
    expect(src).toMatch(/window\.TA/);
    expect(src, 'board.js still hardcodes a count').not.toMatch(/TA_REVIEWS\s*=\s*\d+/);
  });

  it('every page that shows the count loads ta-data.js', () => {
    for (const page of [...PAGES, 'board.html']) {
      expect(read(page), page).toMatch(/<script src="ta-data\.js(\?v=\w+)?"/);
    }
  });

  // The static text is the fallback; paint() is what will carry a live figure once the
  // count comes from the Tripadvisor API. Drive it with a number the markup does NOT
  // ship, so a no-op paint can't pass by accident.
  describe('paint() refreshes the real markup', () => {
    const grab = (page, re) => {
      const m = read(page).match(re);
      if (!m) throw new Error(`markup not found in ${page} — did the badge change?`);
      return m[0];
    };

    it('rewrites the hero badge text and its aria-label together', () => {
      document.body.innerHTML = grab('index.html', /<a class="hero-badge"[\s\S]*?<\/a>/);
      const TA = loadTA();
      TA.reviews = 99;
      TA.paint();

      const badge = document.querySelector('.hero-badge');
      expect(badge.textContent).toContain('99 reviews');
      expect(badge.getAttribute('aria-label')).toContain('99 reviews');
      expect(badge.getAttribute('aria-label')).toContain('Rated 5.0');
    });

    it('rewrites the pay-page trust line', () => {
      document.body.innerHTML = grab('booking.html', /<p class="trust-line">[\s\S]*?<\/p>/);
      const TA = loadTA();
      TA.reviews = 99;
      TA.paint();

      expect(document.querySelector('.trust-line').textContent)
        .toContain('from 99 travellers on Tripadvisor');
    });
  });
});
