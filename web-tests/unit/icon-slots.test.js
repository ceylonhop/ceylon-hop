import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

const read = p => readFileSync(join(ROOT, p), 'utf8');

// Every page that carries a `.val` value-proposition row. Each row is three cards;
// each card must have its own icon, or the row is saying one thing three times.
const VAL_PAGES = ['index.html', 'why.html', 'about.html'];

/** Every `src` on an `<img class="ico">`, in document order. */
function icoSrcs(html) {
  return [...html.matchAll(/<img[^>]*class="ico"[^>]*>/g)]
    .map(([tag]) => (tag.match(/src="([^"]+)"/) || [])[1])
    .filter(Boolean);
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

  it('why.html and about.html do not reuse each other’s icons', () => {
    const why = new Set(icoSrcs(read('why.html')));
    const about = icoSrcs(read('about.html'));
    const shared = about.filter(src => why.has(src));
    expect(shared).toEqual([]);
  });

  // Each row must rotate teal / sky / saffron — the rule in img/icons/badges/README.md,
  // and what the original PNG trio did. The disc is the first <path> fill in the badge.
  it.each(VAL_PAGES)('%s: the value row rotates its disc colours', page => {
    const discs = icoSrcs(read(page)).map(src => {
      const svg = readFileSync(join(ROOT, src), 'utf8');
      return (svg.match(/<path[^>]*fill="(#[0-9A-Fa-f]{6})"/) || [])[1];
    });
    expect(discs.filter(Boolean)).toHaveLength(discs.length);
    expect(new Set(discs).size).toBe(discs.length);
  });
});
