import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { JSDOM } from 'jsdom';
import { ROOT } from '../../tools/generate-route-pages.mjs';

// The hero photos used to live only as base64 inside image-slots.state.json: one 490 KB file
// that every page with an <image-slot> downloads, fetched by image-slot.js at the end of <body>.
// On a throttled phone the homepage photo (its largest paint) showed at 14 s; as a real file the
// HTML points at, 3.6 s. A photo dropped in with the design tool lands back in that sidecar as
// base64 — move it to img/ and point the slot's src at it instead.

const read = (file) => readFileSync(join(ROOT, file), 'utf8');
const doc = (file) => new JSDOM(read(file)).window.document;

describe('slot photos are files, not base64 in the sidecar', () => {
  it('image-slots.state.json carries no image data', () => {
    expect(read('image-slots.state.json')).not.toMatch(/data:image\//);
  });

  it.each([
    ['index.html', 'hero-photo'],
    ['about.html', 'about-hero'],
    ['blog.html', 'blog-hero'],
    ['why.html', 'why-hero'],
  ])('%s #%s points at a file that exists', (page, id) => {
    const src = doc(page).getElementById(id)?.getAttribute('src');
    expect(src).toMatch(/^img\//);
    expect(existsSync(join(ROOT, src))).toBe(true);
  });
});

describe('the homepage hero paints without waiting for JS', () => {
  it('the first photo is also a plain <img> in the HTML, eagerly loaded', () => {
    const d = doc('index.html');
    const base = d.querySelector('#pc-photos > img.pc-base');
    expect(base).not.toBeNull();
    expect(base.getAttribute('src')).toBe(d.getElementById('hero-photo').getAttribute('src'));
    expect(base.getAttribute('loading')).not.toBe('lazy');
  });

  // Chrome does not count a paint at opacity 0 as the largest content, so a fade-in hides the
  // headline and photo from LCP until the animation runs.
  it.each(['heroUp', 'heroPhoto'])('@keyframes %s does not start invisible', (name) => {
    const from = read('index.html').match(new RegExp(`@keyframes ${name}\\{from\\{([^}]*)\\}`));
    expect(from).not.toBeNull();
    expect(from[1]).not.toMatch(/opacity\s*:\s*0/);
  });
});
