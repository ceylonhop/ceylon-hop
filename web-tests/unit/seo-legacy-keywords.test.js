// web-tests/unit/seo-legacy-keywords.test.js
// The route pages inherited the old WordPress site's rankings at the 2026-09-20 apex cutover.
// Its sitemap (pulled from the origin that day) shows what those pages were ABOUT:
//     "Kandy to Ella - Shared Taxi"      "Shared Ride - Negombo to Sigiriya"
// and docs/seo-migration-plan.md names "Kandy to Ella shared taxi" as the query this business
// lives on. The new pages said "private transfer" and "shared seat" — accurate, but the phrase
// "shared taxi" appeared on none of them and "taxi" once. A redirect hands a page the old URL's
// authority; it cannot make a page that never says "taxi" relevant to a search for one.
//
// The constraint that makes this more than find-and-replace is HONESTY. A private-only route
// must never promise a shared seat in the search result (generate-route-pages.mjs already says
// so), and Kandy → Ella — the old site's best-known "shared taxi" page — sells no seat today.
// So "shared taxi" goes in the title ONLY where a seat is genuinely sold; a private-only page
// instead ANSWERS the shared-taxi question truthfully, which is what that searcher needs anyway.
import { describe, it, expect } from 'vitest';
import { generateAll } from '../../tools/generate-route-pages.mjs';
import { loadTransfers } from '../../tools/load-transfers.mjs';

const T = loadTransfers();
const pages = [...generateAll()].filter(([p]) => /^trip\/.+-to-.+\/index\.html$/.test(p));
const legOf = (p) => p.match(/^trip\/(.+)-to-(.+)\/index\.html$/).slice(1, 3);
const decode = (s) => s.replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"');
const titleOf = (html) => decode(html.match(/<title>([^<]*)<\/title>/)[1]);
const descOf = (html) => decode(html.match(/<meta name="description" content="([^"]*)"/)[1]);
// The FAQ is a native <details> accordion now (it used to be a stack of <div class="faq-q">
// with an <h3>). Same array, same wording, same two keyword-bearing questions — only the
// element that carries the question changed, so this reads <summary> instead of <h3>.
const faqQuestions = (html) => [...html.matchAll(/<summary>([^<]*)<\/summary><p>([\s\S]*?)<\/p>/g)]
  .map((m) => [decode(m[1]), decode(m[2].replace(/<[^>]+>/g, ''))]);

const sharedPages = pages.filter(([p]) => T.sharedOption(...legOf(p)));
const privatePages = pages.filter(([p]) => !T.sharedOption(...legOf(p)));

describe('route pages keep the vocabulary the old site ranked for', () => {
  it('has both kinds of route to test, or the rest proves nothing', () => {
    expect(sharedPages.length).toBeGreaterThan(0);
    expect(privatePages.length).toBeGreaterThan(0);
  });

  it('says "taxi" in every title, ahead of where a search result truncates', () => {
    for (const [path, html] of pages) {
      const at = titleOf(html).toLowerCase().indexOf('taxi');
      expect(at, `${path} title: ${titleOf(html)}`).toBeGreaterThan(-1);
      expect(at, `${path} — "taxi" must land inside the first 60 chars`).toBeLessThan(60);
    }
  });

  it('says "shared taxi" in the title and description wherever a seat is genuinely sold', () => {
    for (const [path, html] of sharedPages) {
      expect(titleOf(html).toLowerCase(), path).toContain('shared taxi');
      expect(descOf(html).toLowerCase(), path).toContain('shared taxi');
    }
  });

  it('never promises sharing in the search result of a private-only route', () => {
    for (const [path, html] of privatePages) {
      expect(titleOf(html), path).not.toMatch(/shar(e|ed|ing)/i);
      expect(descOf(html), path).not.toMatch(/shar(e|ed|ing)/i);
    }
  });

  it('answers the shared-taxi question honestly on a private-only route', () => {
    for (const [path, html] of privatePages) {
      const hit = faqQuestions(html).find(([q]) => /shared taxi/i.test(q));
      expect(hit, `${path} needs a FAQ whose question says "shared taxi"`).toBeTruthy();
      expect(hit[1], `${path} must say plainly that it is private-only`).toMatch(/private-only/i);
    }
  });

  it('keeps "door to door" a private-transfer promise — a shared seat boards at a stop', () => {
    for (const [path, html] of sharedPages) {
      const d = descOf(html);
      const shared = d.toLowerCase().indexOf('shared taxi');
      const door = d.toLowerCase().indexOf('door to door');
      if (door === -1) continue;
      expect(door, `${path}: "door to door" must describe the private option, so it comes first — ${d}`)
        .toBeLessThan(shared);
    }
  });

  it('mirrors the FAQ wording in the JSON-LD a crawler reads', () => {
    for (const [path, html] of privatePages) {
      const ld = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)]
        .map((m) => JSON.parse(m[1])).find((o) => o['@type'] === 'FAQPage');
      expect(ld.mainEntity.some((e) => /shared taxi/i.test(e.name)), path).toBe(true);
    }
  });
});
