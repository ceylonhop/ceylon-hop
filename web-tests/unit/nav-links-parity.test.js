import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ROOT } from '../../tools/generate-route-pages.mjs';

// The header nav is written down three times: site.js (every live page), tools/site-chrome.mjs
// (every generated page — /trip/*, terms, privacy, 404, the guides) and board.html, which
// hand-writes its header so "My rides" can sit in it. Nothing tied them together, which is how
// the ride board ended up reachable only from /trip/ pages until 2026-09-18: adding a link in
// one place silently leaves the other two behind, and the nav changes as you click around.

const read = p => readFileSync(join(ROOT, p), 'utf8');

/** [label, href] pairs out of a `const NAVLINKS = [ ... ];` literal. */
const fromLiteral = src => {
  const block = src.match(/const NAVLINKS = \[([\s\S]*?)\];/);
  if (!block) return [];
  return [...block[1].matchAll(/\['([^']+)',\s*'([^']+)'\]/g)].map(([, t, h]) => [t, h]);
};
/** [label, href] pairs out of the first element with this class in an HTML file. */
const fromHtml = (src, cls) => {
  const block = src.match(new RegExp(`<div class="${cls}"[^>]*>([\\s\\S]*?)</div>`));
  if (!block) return [];
  return [...block[1].matchAll(/<a href="([^"#]+)"[^>]*>([^<]+)<\/a>/g)].map(([, h, t]) => [t.trim(), h]);
};

describe('header nav — one link set, three copies', () => {
  const live = fromLiteral(read('site.js'));
  const generated = fromLiteral(read('tools/site-chrome.mjs'));
  const board = read('board.html');

  // Labelled "Share a ride", not "Ride board": route pages present ONE shared option and are
  // guarded against naming the board (route-page-unified.test.js), and the nav is on those pages.
  it('site.js is parseable and links the board', () => {
    expect(live.length).toBeGreaterThan(3);
    expect(live).toContainEqual(['Share a ride', 'board.html']);
  });

  it('generated pages get the same links, in the same order', () => {
    expect(generated).toEqual(live);
  });

  it("board.html's hand-written header matches, desktop and mobile", () => {
    expect(fromHtml(board, 'nav-links')).toEqual(live);
    expect(fromHtml(board, 'mobile-menu')).toEqual(live); // "My rides" is href="#", so it is skipped
  });
});
