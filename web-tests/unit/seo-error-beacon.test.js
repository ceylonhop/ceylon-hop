import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, generateAll } from '../../tools/generate-route-pages.mjs';

const read = (p) => readFileSync(join(ROOT, p), 'utf8');

// M17 (O3/O4): every customer-facing page carries the error beacon so front-end JS
// errors reach /errors/client (and from there Sentry + the founder's alert email).
const FROZEN_PAGES = ['index.html', 'about.html', 'blog.html', 'booking.html', 'plan.html', 'search.html', 'tour.html', 'tours.html', 'why.html'];

const hasBeacon = (html) =>
  html.includes("'/errors/client'") &&
  html.includes('unhandledrejection') &&
  html.includes('sendBeacon');

describe('front-end error beacon (M17)', () => {
  it('is present on all 9 existing pages', () => {
    for (const p of FROZEN_PAGES) {
      expect(hasBeacon(read(p)), `${p} missing the error beacon`).toBe(true);
    }
  });

  it('is emitted by the generator on route pages and the trip index', () => {
    const out = generateAll();
    expect(hasBeacon(out.get('trip/kandy-to-ella/index.html'))).toBe(true);
    expect(hasBeacon(out.get('trip/index.html'))).toBe(true);
  });

  it('is on the generated standalone pages (terms, privacy, 404)', () => {
    for (const p of ['terms.html', 'privacy.html', '404.html']) {
      expect(hasBeacon(read(p)), `${p} missing the error beacon`).toBe(true);
    }
  });

  it('caps beacons per page (hot-loop protection) and never throws itself', () => {
    // the snippet is self-contained: cap counter + try/catch around the send
    const html = read('terms.html');
    const snippet = html.slice(html.indexOf('/errors/client') - 400, html.indexOf('/errors/client') + 800);
    expect(snippet).toContain('n>=5');
    expect(snippet).toContain('catch');
  });
});
