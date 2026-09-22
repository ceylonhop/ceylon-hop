import { describe, it, expect } from 'vitest';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT, generateAll } from '../../tools/generate-route-pages.mjs';
import { loadPlacePhotos, photoFor, imgTag } from '../../tools/place-photos.mjs';

/** Real pixel size from a JPEG's SOF marker — no library, so a stale manifest w/h can't hide. */
function jpegSize(path) {
  const buf = readFileSync(path);
  let offset = 2; // past SOI (0xFFD8)
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`bad JPEG marker at ${offset} in ${path}`);
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    offset += 2 + len;
  }
  throw new Error(`no SOF marker found in ${path}`);
}

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
  it.each(ids)('%s imgTag reports the intrinsic (1800-file) size, not a rounded 900w guess', (id) => {
    const p = photoFor(photos, id);
    const img = imgTag(p, { p: '../../', sizes: '100vw' });
    expect(img).toContain(`width="${p.w}" height="${p.h}"`);
  });
  it.each(ids)('%s -900.jpg is really the same aspect ratio as the manifest', (id) => {
    const { stem } = photoFor(photos, id);
    const p = photoFor(photos, id);
    const real900 = jpegSize(join(ROOT, `img/places/${stem}-900.jpg`));
    const expectedHeight = (p.h * real900.width) / p.w;
    expect(Math.abs(real900.height - expectedHeight)).toBeLessThanOrEqual(1);
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
