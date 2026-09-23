// web-tests/unit/static-chrome-crawlable.test.js
// Every page must carry its footer in the DELIVERED HTML, not only after site.js runs.
//
// Why this is an SEO bug and not a nicety: the footer is the only sitewide link to the route
// index (`trip/`), and from there to the 44 route pages. On terms/privacy/404 and the generated
// route pages the chrome is baked in at build time (render-page.mjs → site-chrome.mjs). On the
// seven pages below it was mounted by site.js at runtime, so a crawler that does not execute
// JavaScript saw FOUR internal links on the homepage and no path into /trip/ at all. Measured on
// the live apex 2026-09-20, the day the cutover handed these pages the old site's rankings.
//
// This does NOT change where any customer-facing link points. The homepage's transfer cards
// still go to search.html — one place per pair, owner decision 2026-09-19 (#641 reverted #591).
// The only new link is the "All routes" footer entry humans already see.
//
// site.js does `host.innerHTML = …`, so at runtime it REPLACES this markup with byte-identical
// output: no duplicate footer, no visual change. The duplicate check below pins that.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Pages whose chrome used to be JS-only. index.html is hand-written; the rest are generated. */
const PAGES = ['index.html', 'about.html', 'blog.html', 'tours.html', 'why.html', 'plan.html', 'search.html'];
/** Already correct — they prove the target shape rather than being changed. */
const ALREADY_STATIC = ['terms.html', 'privacy.html', '404.html', 'trip/index.html'];

const read = (p) => readFileSync(path.join(ROOT, p), 'utf8');
/** What a crawler that does not run JavaScript actually parses. */
const noJs = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');

describe('every page ships its footer in the HTML, not only via site.js', () => {
  it.each([...PAGES, ...ALREADY_STATIC])('%s has a <footer> without JavaScript', (page) => {
    expect(noJs(read(page))).toMatch(/<footer/);
  });

  it.each([...PAGES, ...ALREADY_STATIC])('%s links the route index without JavaScript', (page) => {
    const links = noJs(read(page)).match(/href="[^"]*trip\/"/g) || [];
    expect(links.length, `${page} must carry the "All routes" link into /trip/`).toBeGreaterThan(0);
  });

  it('mounts exactly one footer host per page, so site.js cannot double it', () => {
    for (const page of PAGES) {
      const html = read(page);
      expect((html.match(/data-footer/g) || []).length, `${page} data-footer hosts`).toBe(1);
      // The pre-rendered markup must live INSIDE the host site.js overwrites. Outside it,
      // site.js would add a second footer rather than replace this one.
      expect(html, `${page}: the static footer must sit inside [data-footer]`)
        .toMatch(/<div data-footer>\s*<footer/);
    }
  });

  it('reaches the legal pages without JavaScript too', () => {
    for (const page of PAGES) {
      const h = noJs(read(page));
      expect(h, `${page} → terms`).toMatch(/href="[^"]*terms\.html"/);
      expect(h, `${page} → privacy`).toMatch(/href="[^"]*privacy\.html"/);
    }
  });

  it('leaves the homepage transfer cards pointing at search.html (owner decision #641)', () => {
    const home = read('index.html');
    expect(home).toContain('search.html?${u}');
    // The fix must not have introduced route-page links into the card grid.
    expect(home.match(/<a class="rt-card"/g) || []).toHaveLength(0);
  });
});

/* The header, too. Sitelinks are picked from strong, repeated, crawlable links with consistent
   anchor text, and on these seven pages the header only existed after site.js ran — the same
   gap the footer had. Baked the same way, into the [data-header] host site.js overwrites. */
describe('every page ships its header nav in the HTML, not only via site.js', () => {
  const HEADER_PAGES = ['index.html', 'about.html', 'blog.html', 'tours.html', 'why.html', 'plan.html', 'search.html'];
  const NAV = [
    ['Routes & prices', 'trip/'],
    ['Share a ride', 'board.html'],
    ['Plan a trip', 'plan.html'],
    ['Tours', 'tours.html'],
    ['About', 'about.html'],
  ];
  const navLinks = (html) => {
    // board.html hand-writes its bar as a <div>; the rest render a <nav>.
    const m = noJs(html).match(/<(nav|div) class="nav-links">([\s\S]*?)<\/\1>/);
    return m ? [...m[2].matchAll(/<a href="([^"]+)"[^>]*>([^<]+)<\/a>/g)].map(([, h, t]) => [t, h]) : null;
  };

  it.each([...HEADER_PAGES, 'board.html', 'trip/index.html', 'trip/kandy-to-ella/index.html', 'terms.html'])(
    '%s carries the five nav links without JavaScript', (page) => {
      const links = navLinks(read(page));
      expect(links, `${page} has no static <nav class="nav-links">`).not.toBeNull();
      // Generated pages prefix hrefs with ../ per depth; compare on the tail.
      expect(links.map(([t, h]) => [t, h.replace(/^(\.\.\/)*/, '')])).toEqual(NAV);
    });

  it('mounts exactly one header host per page, with the markup inside it', () => {
    for (const page of HEADER_PAGES) {
      const html = read(page);
      expect((html.match(/data-header/g) || []).length, `${page} data-header hosts`).toBe(1);
      expect(html, `${page}: the static header must sit inside [data-header]`)
        .toMatch(/<div data-header>\s*<header class="nav/);
    }
  });

  it('marks the active section and the on-dark heroes, so nothing jumps when site.js takes over', () => {
    // active = what the page passes to initChrome. blog/why are no longer IN the nav, so they
    // highlight nothing — exactly what site.js renders for them too.
    for (const [page, active, onDark] of [
      ['index.html', '', false], ['about.html', 'about.html', true], ['blog.html', 'blog.html', true],
      ['why.html', 'why.html', true], ['tours.html', 'tours.html', false], ['plan.html', 'plan.html', false],
      ['search.html', '', false],
    ]) {
      const header = read(page).match(/<div data-header>\s*(<header[^>]*>)/)?.[1] || '';
      expect(header.includes('on-dark'), `${page} on-dark`).toBe(onDark);
      const nav = noJs(read(page)).match(/<nav class="nav-links">[\s\S]*?<\/nav>/)?.[0] || '';
      const inNav = NAV.some(([, h]) => h === active);
      expect((nav.match(/class="active"/g) || []).length, `${page} active links`).toBe(inNav ? 1 : 0);
      if (inNav) expect(nav).toMatch(new RegExp(`href="${active.replace('.', '\\.')}" class="active"`));
    }
  });
});
