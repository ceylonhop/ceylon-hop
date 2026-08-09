import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/*
  Two rules the brand pass established, and then broke in the places it did not look.

  1. WEIGHT. The display face is Bodoni 72, which ships Book (400) and Bold (700) and
     nothing else. Ask for anything in between and the browser SYNTHESISES it, which on a
     face with Bodoni's thick/thin contrast smears the hairlines into mud. #379 fixed this
     for the ops UI and guarded it in ops-bulk-close.test.js — but the same bug was live on
     the CUSTOMER site the whole time: every generated /trip/ and blog hero asked for 800,
     verified rendering as synthesised bold at 60.8px.

     This guard covers the surfaces #379's did not: site.css, board.html, the preview
     harness, and — most importantly — the two GENERATORS, since a weight fixed only in the
     output files comes straight back on the next `npm run generate`.

  2. ICON STROKE. The inline line-icon system is one weight, 1.75. An icon that omits
     stroke-width entirely does not inherit it — SVG's initial value is 1, so it renders
     ~43% lighter than everything beside it. Five shipped that way, silently, because the
     normalisation pass rewrote EXISTING stroke-width values and never looked for missing
     ones. The standalone library in img/icons/line/ has to match the same number, or
     dropping one beside an inline icon shows a visible weight step.
*/

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p) => readFileSync(path.join(root, p), 'utf8');

/** Weights Bodoni 72 does not have. 400 and 700 are the only real ones. */
const SYNTHESISED = '(100|200|300|500|600|800|900)';

/* Files that style the display face. The generators are the important entries: their
   output is ~60 route and blog pages, so guarding only the built HTML would let the
   next `npm run generate` reintroduce it. */
const DISPLAY_SURFACES = [
  'site.css',
  'board.html',
  'index.html',
  '_ops-preview.html',
  'api/src/routes/ops-ui.html',
  'tools/generate-route-pages.mjs',
  'tools/generate-static-pages.mjs',
];

describe('the display face only ever asks for weights Bodoni 72 ships', () => {
  for (const file of DISPLAY_SURFACES) {
    it(`${file} names no synthesised weight`, () => {
      const src = read(file);
      const familyFirst = src.match(new RegExp(`font-family:\\s*var\\(--display\\)[^}]*font-weight:\\s*${SYNTHESISED}`, 'g')) || [];
      const weightFirst = src.match(new RegExp(`font-weight:\\s*${SYNTHESISED}[^}]*font-family:\\s*var\\(--display\\)`, 'g')) || [];
      const bad = [...familyFirst, ...weightFirst];
      expect(bad, `synthesised weight in ${file}: ${bad.join(' | ')}`).toEqual([]);
    });
  }

  /* h1-h4 inherit --display from site.css, so a hero rule can request a synthesised
     weight without ever naming the family — which is exactly how the /trip/ pages
     shipped at 800. Checking the family alone would miss it. */
  it('hero headings in the generators do not request one either', () => {
    const bad = [];
    for (const file of ['tools/generate-route-pages.mjs', 'tools/generate-static-pages.mjs']) {
      const src = read(file);
      for (const m of src.matchAll(new RegExp(`\\.[\\w-]*hero\\s+h[1-4]\\s*\\{[^}]*font-weight:\\s*${SYNTHESISED}`, 'g'))) {
        bad.push(`${file}: ${m[0].slice(0, 60)}`);
      }
    }
    expect(bad, `hero heading on a synthesised weight: ${bad.join(' | ')}`).toEqual([]);
  });
});

describe('the line-icon system is a single stroke weight', () => {
  const INLINE = ['index.html', 'board.html', 'api/src/routes/ops-ui.html', '_ops-preview.html', 'pay.html', 'quote.html']
    .filter((p) => existsSync(path.join(root, p)));

  it('no inline icon omits stroke-width (SVG would default it to 1)', () => {
    const bad = [];
    for (const file of INLINE) {
      const src = read(file);
      const missing = src.match(/<svg(?![^>]*stroke-width=)[^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*>/g) || [];
      if (missing.length) bad.push(`${file} (${missing.length})`);
    }
    expect(bad, `icons that would render at weight 1: ${bad.join(', ')}`).toEqual([]);
  });

  it('every inline icon uses 1.75', () => {
    const weights = new Set();
    for (const file of INLINE) {
      for (const m of read(file).matchAll(/<svg[^>]*viewBox="0 0 24 24"[^>]*stroke="currentColor"[^>]*?stroke-width="([\d.]+)"/g)) {
        weights.add(m[1]);
      }
    }
    expect([...weights].sort(), 'the inline set must be one weight').toEqual(['1.75']);
  });

  it('the standalone img/icons/line/ library uses the same weight', () => {
    const dir = path.join(root, 'img/icons/line');
    if (!existsSync(dir)) return;
    const off = readdirSync(dir)
      .filter((f) => f.endsWith('.svg'))
      .map((f) => [f, (readFileSync(path.join(dir, f), 'utf8').match(/stroke-width="([\d.]+)"/) || [])[1]])
      .filter(([, w]) => w !== '1.75');
    expect(off.map(([f, w]) => `${f}=${w}`), 'library must match the inline system').toEqual([]);
  });
});
