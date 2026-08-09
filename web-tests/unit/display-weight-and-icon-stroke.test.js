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
  /* The booking flow. Left off the original list, which is how .tr-leg-title sat at
     Poppins 800 while plan.html rendered the identical route name in Bodoni one step
     earlier — the drift nobody had a test pointed at. */
  'booking.html',
  'plan.html',
  'quote.css',
  'ticket.css',
  'search.html',
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

/*
  The nouns of the product — route names, place names and money — carry the display face,
  so the same string wears the same face on every step of a trip. See the WHERE THE DISPLAY
  FACE GOES block in site.css.

  This is pinned by SELECTOR rather than by counting families, because the failure it guards
  is not "a page has no Bodoni on it" — booking.html had plenty, in its headings and its
  total. The failure is one specific element quietly rendering the same words in a different
  face from the step before it, which no aggregate check can see.
*/
describe('route names, place names and money are on the display face', () => {
  const NOUNS = [
    ['plan.html', '.dr-route'],                       // dates step, "A → B"
    ['booking.html', '.trip-route .tr-leg-title'],    // service step, the SAME "A → B"
    ['booking.html', '.trip-route .tr-stop .tr-name'],
    ['booking.html', '.shared-route .sr-line b'],     // board-at / drop-off places
    ['booking.html', '.mstrip .ms-route'],
    ['booking.html', '.s-total b'],
    ['board.html', '.lcard-route'],
    ['board.html', '.lprice b'],
    ['board.html', '.rr-stop b'],
    ['search.html', '.srch-locked .sl-route'],
    ['ticket.css', '.tot .v'],
    /* The day rows on quote.html, pay.html and manage.html — the SAME route name again,
       now on the document the customer pays from. It shipped at .88rem Poppins, which no
       size-based check could flag: the rule was conformant, the size was just under the
       floor, and the disagreement only shows when you put the receipt next to the
       booking flow that produced it. */
    ['ticket.css', '.hop-t'],
    ['quote.css', '.opt-n'],
  ];

  for (const [file, selector] of NOUNS) {
    it(`${file} — ${selector}`, () => {
      const src = read(file);
      const at = src.indexOf(selector + '{');
      expect(at, `${selector} not found in ${file} — was it renamed?`).toBeGreaterThan(-1);
      const block = src.slice(at, src.indexOf('}', at));
      expect(block, `${selector} left the display face`).toMatch(/font-family:\s*var\(--display\)/);
    });
  }

  /* A VARIANT of a noun — .hop.is-stay .hop-t, .tr-gap .tr-leg-title — restyles an element
     that is already on the display face, so it never names the family and the weight guard
     above cannot see it. That is the same blind spot the /trip/ heroes shipped 800 through.
     Both of these asked for 600 before this pass, which Bodoni would have synthesised. */
  const VARIANTS = [
    ['quote.css', '.hop.is-stay .hop-t'],
    ['booking.html', '.trip-route .tr-leg.tr-gap .tr-leg-title'],
  ];

  for (const [file, selector] of VARIANTS) {
    it(`${file} — ${selector} stays on a weight Bodoni ships`, () => {
      const src = read(file);
      const at = src.indexOf(selector + '{');
      expect(at, `${selector} not found in ${file} — was it renamed?`).toBeGreaterThan(-1);
      const weight = src.slice(at, src.indexOf('}', at)).match(/font-weight:\s*(\d{3})/);
      if (!weight) return; // inherits the base rule's weight, which the NOUNS check covers
      expect(['400', '700'], `${selector} at ${weight[1]} would be synthesised`).toContain(weight[1]);
    });
  }

  /* The floor. Bodoni's hairlines thin to mush under 16px, so a rule may reach for the
     display face OR go below 1rem, never both. This is what keeps "put the nouns in
     Bodoni" from creeping down into chips, captions and micro-labels. */
  it('nothing asks for the display face below the 1rem floor', () => {
    const bad = [];
    for (const file of DISPLAY_SURFACES.filter((f) => /\.(html|css)$/.test(f))) {
      for (const m of read(file).matchAll(/([^{}@\/;]+)\{([^{}]*font-family:\s*var\(--display\)[^{}]*)\}/g)) {
        const size = m[2].match(/font-size:\s*([\d.]+)rem/);
        if (size && parseFloat(size[1]) < 1) bad.push(`${file}: ${m[1].trim()} at ${size[1]}rem`);
      }
    }
    expect(bad, `display face under 16px: ${bad.join(' | ')}`).toEqual([]);
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
