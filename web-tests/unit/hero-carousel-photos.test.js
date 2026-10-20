import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../tools/generate-route-pages.mjs';

// The homepage hero is a four-photo carousel. Only the first photo is part of the page load
// (see hero-photo-lcp.test.js) — the other three carry their file in data-src, not src, so the
// browser does not fetch them alongside the page; the carousel script copies data-src into src
// after the window load event. A plain src here would put 3 more photos in the critical path.

const doc = new JSDOM(readFileSync(join(ROOT, 'index.html'), 'utf8')).window.document;
const LATE = ['hero-photo-2', 'hero-photo-3', 'hero-photo-4'];
const BUDGET = 200 * 1024;

describe('homepage hero carousel photos', () => {
  it('has four slides: the first photo plus three deferred ones', () => {
    const ids = [...doc.querySelectorAll('#pc-photos image-slot')].map((s) => s.id);
    expect(ids).toEqual(['hero-photo', ...LATE]);
  });

  it.each(LATE)('#%s is deferred: no src, a data-src file that exists and is under budget', (id) => {
    const slot = doc.getElementById(id);
    expect(slot.hasAttribute('src')).toBe(false);
    const file = slot.getAttribute('data-src');
    expect(file).toMatch(/^img\/hero-photo-\d\.jpg$/);
    expect(existsSync(join(ROOT, file))).toBe(true);
    expect(statSync(join(ROOT, file)).size).toBeLessThanOrEqual(BUDGET);
  });
});
