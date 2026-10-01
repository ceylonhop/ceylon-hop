// Every destination guide's JSON must be internally consistent and every photo it names must
// exist at both sizes with the dimensions the JSON declares (the <img width/height> reserve
// the box; a wrong ratio shifts layout — same lesson as tools/place-photos.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Real pixel size from a JPEG's SOF marker — the same reader as place-photos.test.js. No `sips`:
    that is macOS-only and CI runs on Linux (it failed there with `spawnSync sips ENOENT`). */
function jpegSize(file) {
  const buf = readFileSync(file);
  let offset = 2; // past SOI (0xFFD8)
  while (offset < buf.length) {
    if (buf[offset] !== 0xff) throw new Error(`bad JPEG marker at ${offset} in ${file}`);
    const marker = buf[offset + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
    const len = buf.readUInt16BE(offset + 2);
    const isSOF = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSOF) return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
    offset += 2 + len;
  }
  throw new Error(`no SOF marker found in ${file}`);
}
const DIR = path.join(ROOT, 'tools/guides');
const guides = readdirSync(DIR).filter(f => f.endsWith('.json'))
  .map(f => JSON.parse(readFileSync(path.join(DIR, f), 'utf8')));

const photoKeys = g => [
  g.hero.photo,
  ...g.places.map(p => p.photo),
  ...(g.onTheWay?.stops || []).map(s => s.photo),
  ...g.eat.map(e => e.photo),
  ...g.stay.map(s => s.photo),
].filter(Boolean);

describe('destination guide content', () => {
  it('has at least the Nuwara Eliya guide', () => {
    expect(guides.map(g => g.slug)).toContain('nuwara-eliya');
  });
  for (const g of guides) {
    describe(g.slug, () => {
      it('has exactly four facts, a placeId, a title and description within SERP limits', () => {
        expect(g.facts).toHaveLength(4);
        expect(g.placeId).toBeTruthy();
        expect(g.title.length).toBeLessThanOrEqual(70);
        expect(g.description.length).toBeLessThanOrEqual(160);
      });
      it('names only photos it declares, and every declared photo exists at 900 and 1800', () => {
        for (const k of photoKeys(g)) expect(g.photos, `photo "${k}"`).toHaveProperty(k);
        for (const [k, meta] of Object.entries(g.photos)) {
          for (const size of [900, 1800]) {
            const f = path.join(ROOT, 'img/guides', g.slug, `${k}-${size}.jpg`);
            expect(existsSync(f), f).toBe(true);
          }
          expect(meta.alt, `${k}.alt`).toBeTruthy();
          expect(meta.credit, `${k}.credit`).toBeTruthy();
          expect(meta.creditUrl, `${k}.creditUrl`).toMatch(/^https:\/\/unsplash\.com\//);
        }
      });
      it('declares the real pixel size of each -1800 file', () => {
        for (const [k, meta] of Object.entries(g.photos)) {
          const f = path.join(ROOT, 'img/guides', g.slug, `${k}-1800.jpg`);
          const { width, height } = jpegSize(f);
          expect([width, height], k).toEqual([meta.w, meta.h]);
        }
      });
      it('has a 1200×630 share image under 300 KB (WhatsApp drops larger previews)', () => {
        const f = path.join(ROOT, 'img/guides', g.slug, 'og.jpg');
        expect(existsSync(f), f).toBe(true);
        expect(jpegSize(f)).toEqual({ width: 1200, height: 630 });
        expect(readFileSync(f).length).toBeLessThan(300 * 1024);
      });
      it('keeps <b> out of place tips (.tip b is the tip’s own label, so it would render as a heading)', () => {
        for (const p of g.places) if (p.tip) expect(p.tip.text, p.id).not.toContain('<b>');
      });
      it('credits every photographer in credits.html', () => {
        const credits = readFileSync(path.join(ROOT, 'credits.html'), 'utf8');
        for (const [k, meta] of Object.entries(g.photos)) {
          expect(credits, `${k} → ${meta.credit}`).toContain(meta.creditUrl);
        }
      });
    });
  }
});
