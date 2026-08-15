import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

function loadTA() {
  // eslint-disable-next-line no-new-func
  new Function(read('ta-data.js'))();
  return window.TA;
}

// The homepage used to show three hand-written testimonials under a "5.0 on Tripadvisor"
// heading, which reads as if Tripadvisor's travellers wrote them. These are now real
// reviews from the listing, quoted verbatim and attributed.
describe('homepage testimonials are real Tripadvisor reviews', () => {
  it('ta-data.js carries the quotes with everything a card needs to attribute them', () => {
    const TA = loadTA();
    expect(Array.isArray(TA.quotes)).toBe(true);
    expect(TA.quotes).toHaveLength(3);

    for (const q of TA.quotes) {
      expect(typeof q.name, `name on ${JSON.stringify(q).slice(0, 40)}`).toBe('string');
      expect(q.name.length).toBeGreaterThan(0);
      // A date is not decoration: quoting a review without one misrepresents how current it is.
      expect(q.written, `written on "${q.name}"`).toMatch(/^[A-Z][a-z]+ \d{4}$/);
      // Long enough to be an actual review rather than a slogan.
      expect(q.text.length, `text on "${q.name}"`).toBeGreaterThan(80);
    }
  });

  it('links to the listing so a reader can verify any quote', () => {
    const TA = loadTA();
    expect(TA.url).toMatch(/tripadvisor\.com\/Attraction_Review-g3736162-d33018957/);
  });

  it('the invented testimonials are gone from the homepage', () => {
    const h = read('index.html');
    for (const ghost of ['Maya', 'Tom & Elise', 'Priya', 'local big brother', '9-stop island trip']) {
      expect(h, `invented testimonial copy still present: "${ghost}"`).not.toContain(ghost);
    }
  });

  it('the homepage renders from the shared quotes, not a page-local array', () => {
    const h = read('index.html');
    expect(h).toMatch(/TA\.quotes/);
    // The old shape was `const reviews=[ [name,country,trip,txt], ... ]` inline in the page.
    expect(h, 'page still declares its own review array').not.toMatch(/const reviews\s*=\s*\[/);
  });

  it('each card is attributed — reviewer, date, and a link back', () => {
    const h = read('index.html');
    const card = h.match(/document\.getElementById\('reviews'\)[\s\S]*?\.join\(''\);/);
    expect(card, 'review render block not found').toBeTruthy();
    const src = card[0];
    expect(src, 'no link to the listing').toMatch(/TA\.url/);
    expect(src, 'review date not rendered').toMatch(/\.written/);
    expect(src, 'reviewer name not rendered').toMatch(/\.name/);
    // Verbatim quoting convention: the text is wrapped in real quotation marks.
    expect(src, 'quote not wrapped in quotation marks').toMatch(/&ldquo;\$\{[\w.]*text\}&rdquo;/);
  });
});
