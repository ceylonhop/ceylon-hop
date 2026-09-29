// Every destination guide's JSON must be internally consistent and every photo it names must
// exist at both sizes with the dimensions the JSON declares (the <img width/height> reserve
// the box; a wrong ratio shifts layout — same lesson as tools/place-photos.mjs).
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
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
          const out = execFileSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', f], { encoding: 'utf8' });
          const w = Number(/pixelWidth:\s*(\d+)/.exec(out)[1]);
          const h = Number(/pixelHeight:\s*(\d+)/.exec(out)[1]);
          expect([w, h], k).toEqual([meta.w, meta.h]);
        }
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
