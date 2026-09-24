import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../tools/generate-route-pages.mjs';

// "shared taxi sri lanka" is the site's best non-brand query (Search Console, Jun–Sep 2026). The
// WordPress page that ranked for it (/routes/, titled "Shared Taxi") now 301s to /trip/, and a
// redirect carries authority, not vocabulary — so the words must live on the pages it lands on.
// Read through JSDOM so entities are decoded and the check can't pass vacuously on raw HTML.
const doc = (file) => new JSDOM(readFileSync(join(ROOT, file), 'utf8')).window.document;
const desc = (d) => d.querySelector('meta[name="description"]').getAttribute('content');

describe('pages that inherited the "shared taxi" searches say "shared taxi"', () => {
  it('/trip/ — title, description and H1', () => {
    const d = doc('trip/index.html');
    expect(d.title).toMatch(/shared taxi/i);
    expect(desc(d)).toMatch(/shared taxi/i);
    expect(d.querySelector('h1').textContent).toMatch(/shared taxi/i);
  });
  it('board.html — title and description', () => {
    const d = doc('board.html');
    expect(d.title).toMatch(/shared taxi/i);
    expect(desc(d)).toMatch(/shared taxi/i);
  });
});
