import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The six "Popular transfers" cards are photo-first (owner pick 2026-10-24, option A of four
   mockups): a 16:10 photo of the DESTINATION on top, the route and price below. The photo is
   found by convention — img/transfer-<to>.jpg — so adding a pair to POP_TRANSFERS without
   adding its photo would ship a broken image. This test fails first. */

const pairs = () => {
  const m = INDEX.match(/const POP_TRANSFERS\s*=\s*\[(.*?)\];/s);
  expect(m, 'POP_TRANSFERS not found in index.html').toBeTruthy();
  return [...m[1].matchAll(/\['([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'\]/g)].map((x) => [x[1], x[2]]);
};

describe('homepage popular-transfer photos', () => {
  it('renders a destination photo on every card, by the img/transfer-<to>.jpg convention', () => {
    expect(INDEX).toContain('src="img/transfer-${t}.jpg"');
  });

  it('ships a photo file for every destination in POP_TRANSFERS', () => {
    const missing = [...new Set(pairs().map(([, t]) => t))]
      .map((t) => `img/transfer-${t}.jpg`)
      .filter((f) => !existsSync(path.join(ROOT, f)));
    expect(missing).toEqual([]);
  });

  it('loads the photos lazily — the section is below the fold on every screen', () => {
    const m = INDEX.match(/<img class="tc-img"[^>]*>/);
    expect(m, 'tile <img> not found').toBeTruthy();
    expect(m[0]).toContain('loading="lazy"');
    expect(m[0]).toContain('decoding="async"');
  });
});
