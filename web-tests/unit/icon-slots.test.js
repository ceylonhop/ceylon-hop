import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

// Every page that carries a `.val` value-proposition row. Each row is three cards;
// each card must have its own icon, or the row is saying one thing three times.
const VAL_PAGES = ['index.html', 'why.html', 'about.html'];

/** Every `src` on an `<img class="...ico...">`, in document order. Matches `ico` as a
 * standalone class token — not a substring of `step-ico` or `hiw-ico` — so a compound
 * class like `class="ico ico-lg"` is still caught. */
function icoSrcs(html) {
  return [...html.matchAll(/<img[^>]*class="[^"]*"[^>]*>/g)]
    .map(([tag]) => tag)
    .filter(tag => (tag.match(/class="([^"]*)"/) || [])[1]?.split(/\s+/).includes('ico'))
    .map(tag => (tag.match(/src="([^"]+)"/) || [])[1])
    .filter(Boolean);
}

/** Just the markup of the `.val` value-proposition row, so callers who only care about that
 * three-card row (like the disc-rotation rule) aren't tripped up by an unrelated `img.ico`
 * elsewhere on the page. Cards are flat — no nested `<div>` — so a non-greedy match to the
 * next `</div>` is enough to isolate one card. */
function valRowHtml(html) {
  return [...html.matchAll(/<div class="val[^"]*">[\s\S]*?<\/div>/g)].map(([tag]) => tag).join('\n');
}

describe('icon slots', () => {
  for (const page of VAL_PAGES) {
    it(`${page}: every icon file it points at actually exists`, () => {
      const missing = icoSrcs(read(page)).filter(src => !existsSync(join(ROOT, src)));
      expect(missing).toEqual([]);
    });

    it(`${page}: no two value cards share the same icon`, () => {
      const srcs = icoSrcs(read(page));
      expect(srcs.length).toBeGreaterThan(0);
      expect(new Set(srcs).size).toBe(srcs.length);
    });
  }

  // Every distinct pair of value-row pages: no page may reuse another's mark. Pairwise,
  // not just why-vs-about, so a future page added to VAL_PAGES is covered automatically.
  for (let i = 0; i < VAL_PAGES.length; i++) {
    for (let j = i + 1; j < VAL_PAGES.length; j++) {
      const [pageA, pageB] = [VAL_PAGES[i], VAL_PAGES[j]];
      it(`${pageA} and ${pageB} do not reuse each other’s icons`, () => {
        const a = new Set(icoSrcs(read(pageA)));
        const b = icoSrcs(read(pageB));
        const shared = b.filter(src => a.has(src));
        expect(shared).toEqual([]);
      });
    }
  }

  // Each row that uses badges must rotate teal / sky / saffron — the rule in
  // img/icons/badges/README.md, and what the original PNG trio did visually. The disc is the
  // first <path> fill in the badge. Scoped to the `.val` row itself: this is a rule about that
  // three-card row, not the whole page, and there are only three brand disc colours to rotate
  // through. index.html's row carries the original reference PNGs, not badges — a PNG has no
  // <path> to read a disc colour from, so it's excluded rather than counted as a colour clash.
  it.each(VAL_PAGES)('%s: the value row rotates its disc colours', page => {
    const discs = icoSrcs(valRowHtml(read(page)))
      .filter(src => src.endsWith('.svg'))
      .map(src => {
        const svg = readFileSync(join(ROOT, src), 'utf8');
        return (svg.match(/<path[^>]*fill="(#[0-9A-Fa-f]{6})"/) || [])[1];
      });
    expect(discs.filter(Boolean)).toHaveLength(discs.length);
    expect(new Set(discs).size).toBe(discs.length);
  });
});
