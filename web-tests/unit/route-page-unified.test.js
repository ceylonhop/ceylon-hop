import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';

/* The route page is THE product page.
   docs/superpowers/plans/2026-08-16-unified-route-page.md

   Two options: private transfer, and the shared taxi where we run one. The shared taxi runs
   on its set days (Wed & Sat) at set times and is paid at booking; on any other day the
   traveller starts their own ride on the ride board, which runs once enough travellers
   commit and only charges once it's confirmed (owner, 2026-09-30). The page names both and
   never lets one borrow the other's promise.

   The load-bearing constraint is SEO: these pages exist to be indexed, so the generator
   must emit the complete flexible state as static HTML. JS may only layer date behaviour
   on top. Every assertion below runs against SCRIPT-STRIPPED markup for that reason. */

const T = loadTransfers();
const pages = [...generateAll()].filter(([p]) => /^trip\/.+-to-.+\/index\.html$/.test(p));

/** What a crawler with no JS actually sees. */
const noJs = (html) => html.replace(/<script[\s\S]*?<\/script>/g, '');
/* Entities are decoded because the generator escapes every content string: a traveller reads
   "Wed & Sat" where the markup says "Wed &amp; Sat". Matching the raw HTML let the off-day
   guard below pass for as long as that phrase was on the Ella → Yala page. */
const text = (html) => noJs(html).replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"')
  .replace(/\s+/g, ' ');
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

const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

describe('route page — the shared taxi on its days, the ride board for the rest', () => {
  it('states the days the shared taxi runs wherever we sell a seat', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      const s = T.sharedOption(from, to);
      if (!s) continue;
      const days = s.days.map(d => DAY_LONG[d]).join(' & ');
      expect(text(html), `${path} running days`).toContain(`Runs every ${days}`);
    }
  });

  it('sends every other day to the ride board, with the board\'s own terms', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      if (!T.sharedOption(from, to)) continue;
      const t = text(html);
      expect(t, `${path} ride board`).toMatch(/start your own ride on the ride board/i);
      expect(t, `${path} board terms`).toMatch(/runs once 3 travellers are going/);
    }
  });

  it('never describes the shared taxi with the ride board\'s payment terms', () => {
    // The shared taxi is paid at booking; "charged only once it's confirmed" is the board's.
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      if (!T.sharedOption(from, to)) continue;
      // The FAQ answers are the JSON-LD FAQPage too — read them from there, entity-free.
      const faq = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map(m => JSON.parse(m[1])).find(o => o['@type'] === 'FAQPage');
      const a = faq.mainEntity.find(q => /shared taxi work/.test(q.name)).acceptedAnswer.text;
      expect(a, `${path} FAQ`).toMatch(/^The shared taxi runs every Wednesday and Saturday/);
      expect(a, `${path} FAQ`).toMatch(/paid when you book/);
      expect(a, `${path} FAQ`).toMatch(/ride board/);
    }
  });

  it('never promises running days on a route with no shared taxi', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      if (T.sharedOption(from, to)) continue;
      expect(text(html), `${path}`).not.toMatch(/Wed & Sat|Wednesday and Saturday|Wednesday & Saturday/i);
    }
  });

  // The refusal used to be half a page — a grey "Shared ride / Not on this route" card sitting
  // beside the real offer, giving equal weight to the thing we don't sell. It is now one line
  // (p.no-share) under the trust strip. Same intent, same routes: a page that cannot sell a
  // seat must SAY so in the static markup rather than leaving the reader to infer it.
  it('says plainly when a route has no shared option at all', () => {
    for (const [path, html] of pages) {
      const [from, to] = legOf(path);
      if (T.sharedOption(from, to) || T.corridorFor(from, to)) continue;
      expect(text(html), `${path} should decline shared`).toMatch(/No shared vehicle runs/);
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
      const s = T.sharedOption(from, to);
      if (s) {
        // The seat books straight into checkout — search.js's own shared bookUrl contract.
        const href = (n.match(/href="([^"]*booking\.html[^"]*mode=shared[^"]*)"/) || [])[1];
        expect(href, `${path} shared CTA`).toBeTruthy();
        const qs = new URLSearchParams(href.replace(/&amp;/g, '&').split('?')[1]);
        expect(qs.get('from')).toBe(from);
        expect(qs.get('to')).toBe(to);
        expect(Number(qs.get('price'))).toBe(s.seat);
        expect(qs.get('days')).toBe(s.days.join(','));
        expect(qs.get('times')).toBe(s.times.join(','));
        expect(qs.get('corridor')).toBe(s.corridorId);
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
