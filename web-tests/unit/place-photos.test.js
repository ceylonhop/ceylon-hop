import { describe, it, expect } from 'vitest';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, generateAll } from '../../tools/generate-route-pages.mjs';
import { loadPlacePhotos, photoFor, imgTag } from '../../tools/place-photos.mjs';

const photos = loadPlacePhotos();
// Only places a generated trip page names need a photo (the catalogue has 19 places; /trip/ uses 11).
// trip/ on disk also holds ~25 hand-built legacy directories (redirect stubs, old tour slugs), so
// enumerate the GENERATED route pages the way route-page-unified.test.js does — never readdir.
const slugs = [...generateAll().keys()].map(k => (k.match(/^trip\/(.+-to-.+)\/index\.html$/) || [])[1]).filter(Boolean);
const ids = [...new Set(slugs.flatMap(s => s.split('-to-'))), '_index'];

describe('place photos — every place a trip page can name has one', () => {
  it.each(ids)('%s has a complete manifest entry', (id) => {
    const p = photoFor(photos, id);
    for (const k of ['stem', 'alt', 'caption', 'credit', 'creditUrl', 'focal']) expect(p[k], `${id}.${k}`).toBeTruthy();
    expect(p.w).toBeGreaterThanOrEqual(1800);
    expect(p.h).toBeGreaterThan(0);
  });
  it.each(ids)('%s ships both widths, hero under 250 KB', (id) => {
    const { stem } = photoFor(photos, id);
    for (const w of [900, 1800]) expect(existsSync(join(ROOT, `img/places/${stem}-${w}.jpg`)), `${stem}-${w}`).toBe(true);
    expect(statSync(join(ROOT, `img/places/${stem}-1800.jpg`)).size).toBeLessThanOrEqual(250 * 1024);
  });
  it('throws loudly for a place with no photo', () => {
    expect(() => photoFor(photos, 'atlantis')).toThrow('place-photos.json missing "atlantis"');
  });
  it('imgTag never omits alt, width or height, and only the hero is eager', () => {
    const p = photoFor(photos, 'ella');
    const hero = imgTag(p, { p: '../../', sizes: '100vw', eager: true, cls: 'hero-img' });
    expect(hero).toContain(`alt="${p.alt}"`);
    expect(hero).toMatch(/width="\d+" height="\d+"/);
    expect(hero).toContain('fetchpriority="high"');
    expect(hero).toContain('../../img/places/ella-900.jpg 900w');
    expect(imgTag(p, { p: '../../', sizes: '25vw' })).toContain('loading="lazy"');
  });
  it('every Unsplash photo is credited on credits.html', async () => {
    const { readFileSync } = await import('node:fs');
    const credits = readFileSync(join(ROOT, 'credits.html'), 'utf8');
    for (const id of ids) {
      const p = photoFor(photos, id);
      if (/unsplash\.com/.test(p.creditUrl)) expect(credits, id).toContain(p.creditUrl);
    }
  });
});
