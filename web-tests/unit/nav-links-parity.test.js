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

/* The footer is written down twice — site.js (every live page) and tools/site-chrome.mjs (every
   generated page) — and the two drifted the same way the header did. The generated footer gained
   "All routes" → /trip/; site.js kept a SECOND link to the blog in that slot instead ("Travel
   guide" in Explore, "Travel blog" in Company). So the 44 route pages were linked from terms,
   privacy, 404 and the guides, and from none of the pages travellers actually land on: the
   homepage, search, about, why, tours, plan. Since the apex cutover (2026-09-20) those pages
   canonical to URLs that resolve, so the missing links are missing ranking. */
describe('footer — one link set, two copies', () => {
  /** [label, href] pairs under a footer column's <h4>, with the generator's `${p}` prefix dropped. */
  const column = (src, heading) => {
    const block = src.match(new RegExp(`<h4>${heading}</h4><ul>([\\s\\S]*?)</ul>`));
    if (!block) return [];
    return [...block[1].matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)]
      .map(([, h, t]) => [t.trim(), h.replace('${p}', '')]);
  };
  const live = read('site.js');
  const generated = read('tools/site-chrome.mjs');

  it('every live page links the route index from its footer', () => {
    expect(column(live, 'Explore')).toContainEqual(['All routes', 'trip/']);
  });

  for (const heading of ['Explore', 'Company']) {
    it(`"${heading}" is the same on live and generated pages`, () => {
      expect(column(live, heading).length).toBeGreaterThan(2);
      expect(column(live, heading)).toEqual(column(generated, heading));
    });
  }

  it('links the blog once, not twice', () => {
    const all = [...column(live, 'Explore'), ...column(live, 'Company')];
    expect(all.filter(([, h]) => h === 'blog.html')).toHaveLength(1);
  });
});

/* Which five links, and in what order — owner decision 2026-09-22. Google's sitelinks for the
   homepage are chosen from the strongest, most consistently linked pages, and two days after
   the apex cutover they were still three dead WordPress pages ("Shared Taxi" = /routes/, "The
   Island Loop 6 Stops", an old trip page) plus Why/About. The header is the signal we control:
   the pages a customer buys from, first, and nothing that competes with them for a slot. The
   blog and Why us stay in the footer, so they are still crawled — just not from the top level. */
describe('header nav — the five sitelinks we want Google to show', () => {
  const live = fromLiteral(read('site.js'));

  it('is Routes, Share a ride, Plan, Tours, About — in that order', () => {
    expect(live).toEqual([
      ['Routes & prices', 'trip/'],
      ['Share a ride', 'board.html'],
      ['Plan a trip', 'plan.html'],
      ['Tours', 'tours.html'],
      ['About', 'about.html'],
    ]);
  });

  it('keeps the blog and Why us reachable from the footer', () => {
    const src = read('site.js');
    expect(src).toMatch(/href="[^"]*blog\.html"/);
    expect(src).toMatch(/href="[^"]*why\.html"/);
  });
});
