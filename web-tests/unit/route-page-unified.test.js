import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';

/* Design A — the route page is THE product page.
   docs/superpowers/plans/2026-08-16-unified-route-page.md

   Two options, never three: private transfer, and ONE shared card. A shared seat is a
   date with names on it, so the words "scheduled" and "ride board" never reach the
   customer, and there is no "unavailable" state for shared — any date can run.

   The load-bearing constraint is SEO: these pages exist to be indexed, so the generator
   must emit the complete flexible state as static HTML. JS may only layer date behaviour
   on top. Every assertion below runs against SCRIPT-STRIPPED markup for that reason. */

const T = loadTransfers();
const pages = [...generateAll()].filter(([p]) => /^trip\/.+-to-.+\/index\.html$/.test(p));

/** What a crawler with no JS actually sees. */
const noJs = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
const text = (html) => noJs(html).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
const legOf = (p) => p.match(/^trip\/(.+)-to-(.+)\/index\.html$/).slice(1, 3);
const money = (n) => (n % 1 === 0 ? String(n) : n.toFixed(2));

describe('route page — renders completely without JavaScript', () => {
  it('states both private fares on every page, in static markup', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      const q = T.privateQuote(from, to);
      const t = text(html);
      expect(t, `${path} car fare`).toContain(`$${money(q.car)}`);
      expect(t, `${path} van fare`).toContain(`$${money(q.van)}`);
    }
  });

  it('states the shared seat price wherever we sell one, in static markup', () => {
    let checked = 0;
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      const s = T.sharedOption(from, to);
      if (!s) continue;
      checked++;
      expect(text(html), `${path} seat price`).toContain(`$${money(s.seat)}`);
    }
    expect(checked, 'at least one page must sell a shared seat').toBeGreaterThan(0);
  });

  it('lists every boarding point and its time, in static markup', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      const s = T.sharedOption(from, to);
      if (!s) continue;
      const t = text(html);
      for (const p of s.pickups) {
        expect(t, `${path} pickup point`).toContain(p.point || p.place);
      }
    }
  });
});

describe('route page — one shared option, never two', () => {
  it('never uses the words that name the distinction we removed', () => {
    for (const [path, html] of pages) {
      const t = text(html);
      expect(t, `${path} must not say "scheduled"`).not.toMatch(/scheduled/i);
      expect(t, `${path} must not say "ride board"`).not.toMatch(/ride board/i);
    }
  });

  it('never tells a traveller a shared seat is unavailable on a date', () => {
    // Under A every date can run, so there is no off-day language to render.
    for (const [path, html] of pages) {
      const t = text(html);
      expect(t, `${path}`).not.toMatch(/Wed & Sat|Wednesday and Saturday|only departs on/i);
    }
  });

  it('says plainly when a route has no shared option at all', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      if (T.sharedOption(from, to) || T.corridorFor(from, to)) continue;
      expect(text(html), `${path} should decline shared`).toMatch(/private[- ]only|no shared/i);
    }
  });
});

describe('route page — it is the destination, not a signpost', () => {
  it('books from the page itself rather than bouncing to search.html', () => {
    for (const [path, html] of pages) {
      expect(noJs(html), `${path} still forwards to search.html`)
        .not.toMatch(/href="[^"]*search\.html\?from=/);
    }
  });

  it('offers a booking action for both products', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      const n = noJs(html);
      expect(n, `${path} private CTA`).toMatch(/href="[^"]*booking\.html[^"]*"/);
      if (T.sharedOption(from, to)) {
        expect(n, `${path} shared CTA`).toMatch(/data-shared-cta|href="[^"]*board\.html/);
      }
    }
  });
});

/* The "Book private transfer" CTA shipped (#543) as `booking.html?from=X&to=Y` with no
   `mode`. booking.js only takes its from/to branch when `mode` is set -- without it the page
   falls through to `getRoute(params.get('id'))`, finds nothing, and does
   location.replace('plan.html'). So the primary CTA on all 44 route pages dumped the
   traveller in the planner instead of booking the transfer they had just priced.

   The e2e that should have caught it asserted toHaveURL(/booking\.html/) immediately after
   the click. toHaveURL polls, and booking.html's URL exists for a few ms before the
   redirect -- so it matched that flicker and passed for the entire time the CTA was broken.

   search.js is the contract: bookUrl({ mode:'private', vehicle, price, rawPrice }). */
describe('the private CTA links somewhere that actually books', () => {
  for (const [path, html] of pages) {
    it(`${path} sends booking.html everything it needs to price the transfer`, () => {
      // script-stripped: a crawler and a no-JS traveller must get a working CTA too
      const href = (noJs(html).match(/href="([^"]*booking\.html[^"]*)"/) || [])[1];
      expect(href, 'no booking.html CTA in the static markup').toBeTruthy();
      const qs = new URLSearchParams(href.replace(/&amp;/g, '&').split('?')[1]);

      // Without mode, booking.js redirects to plan.html and the priced route is lost.
      expect(qs.get('mode'), `${path} CTA is missing mode=private`).toBe('private');
      expect(qs.get('from')).toBeTruthy();
      expect(qs.get('to')).toBeTruthy();
      expect(qs.get('vehicle')).toBe('car');
      // Same money contract search.js uses: display price plus the unfinished fare, so
      // extras are added before the single finishing pass in calcTotal().
      expect(Number(qs.get('price')), `${path} price`).toBeGreaterThan(0);
      expect(Number(qs.get('rawPrice')), `${path} rawPrice`).toBeGreaterThan(0);
    });
  }
});
