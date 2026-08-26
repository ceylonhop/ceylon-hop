import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const INDEX = readFileSync(path.join(ROOT, 'index.html'), 'utf8');

/* The homepage's six "Popular transfers" cards are its main conversion path, and they now point
   at /trip/<from>-to-<to>/ rather than search.html. Those pages are GENERATED, so the pair list
   and the generated set can drift apart in either direction — add a pair here, or drop a route
   from the generator, and the homepage ships a dead link on its most prominent cards. Nothing
   else would catch it: the pages are built from routes-data, not from this list.

   This also pins the only internal links the /trip/ pages have. Nothing else on the site links
   to them, and an orphaned page does not rank, so losing these silently would undo the reason
   they were pointed here. */

const pairs = () => {
  const m = INDEX.match(/const POP_TRANSFERS\s*=\s*\[(.*?)\];/s);
  expect(m, 'POP_TRANSFERS not found in index.html').toBeTruthy();
  return [...m[1].matchAll(/\['([a-z0-9-]+)'\s*,\s*'([a-z0-9-]+)'\]/g)].map((x) => [x[1], x[2]]);
};

describe('homepage popular-transfer cards', () => {
  it('names at least the six pairs the design calls for', () => {
    expect(pairs().length).toBeGreaterThanOrEqual(6);
  });

  it('links every pair to a route page that actually exists', () => {
    for (const [from, to] of pairs()) {
      const slug = `${from}-to-${to}`;
      expect(
        existsSync(path.join(ROOT, 'trip', slug, 'index.html')),
        `homepage links trip/${slug}/ but no such page is generated`,
      ).toBe(true);
    }
  });

  it('builds the href from the pair, so it cannot drift from the list', () => {
    expect(INDEX).toContain('href="trip/${f}-to-${t}/"');
  });
});
