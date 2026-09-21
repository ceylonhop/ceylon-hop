import { test, expect } from '@playwright/test';

/* The /trip/ redesign puts the fares card INSIDE the photo hero, overlapping its bottom edge
   by 64px. Three things break if that overlap is built carelessly, and none of them shows up
   in a unit test or a full-page thumbnail:

   1. `overflow:hidden` on the hero section clips the card — the Book button gets sliced in
      half. The photo and its gradient have to be contained in an inner wrapper instead.
   2. The trust strip sits directly under the hero, so the overhanging card lands ON TOP of
      its right-hand end. The strip has to RESERVE that space (and so does the private-only
      note, which sits just below it), or items are unreadable and unclickable.
   3. On a phone the whole point is a price above the fold; if the hero copy grows, the fare
      and the CTA slide off the first screen and the page reads like the old signpost again.

   So this spec hit-tests rather than measures: `elementFromPoint` at an element's own edge is
   the only assertion that can see a clip or an occlusion. site.css sets
   `html{scroll-behavior:smooth}` globally, so every scroll here is `behavior:'instant'` —
   a smooth scroll would still be gliding when the rect is sampled. And deliberately never
   scrollIntoView(): that can scroll an overflow:hidden ANCESTOR rather than the page, which
   hides the very clipping this spec exists to catch. */

const PAGES = [
  { name: 'kandy-to-ella (private only)', url: '/trip/kandy-to-ella/?api=off', privateOnly: true },
  { name: 'cmb-airport-to-sigiriya (shared)', url: '/trip/cmb-airport-to-sigiriya/?api=off', privateOnly: false },
];
const VIEWPORTS = [
  { width: 1280, height: 900 },
  { width: 1024, height: 800 },
  { width: 375, height: 812 },
];

/** Is the nth match of `selector` the thing you actually touch at its own edge?
 *  `where` is 'bottom' (centre-x, bottom-2) or 'right' (right-2, centre-y). */
function hitTest(page, selector, index, where) {
  return page.evaluate(({ selector, index, where }) => {
    const el = document.querySelectorAll(selector)[index];
    if (!el) return { ok: false, why: 'no such element' };
    const vh = window.innerHeight;
    let r = el.getBoundingClientRect();
    if (r.bottom > vh - 8 || r.top < 8) {
      window.scrollBy({ top: Math.round(r.bottom - vh * 0.6), left: 0, behavior: 'instant' });
      r = el.getBoundingClientRect();
    }
    const x = where === 'right' ? Math.round(r.right - 2) : Math.round(r.left + r.width / 2);
    const y = where === 'right' ? Math.round(r.top + r.height / 2) : Math.round(r.bottom - 2);
    if (x < 0 || y < 0 || x > window.innerWidth || y > vh) {
      return { ok: false, why: `point ${x},${y} is off-screen even after scrolling` };
    }
    const at = document.elementFromPoint(x, y);
    if (at === el || (at && el.contains(at))) return { ok: true, why: '' };
    const name = at ? at.tagName.toLowerCase() + (at.className ? '.' + String(at.className).trim().split(/\s+/).join('.') : '') : 'nothing';
    return { ok: false, why: `at ${x},${y} you touch ${name}, not this element` };
  }, { selector, index, where });
}

for (const p of PAGES) {
  for (const vp of VIEWPORTS) {
    test(`${p.name} @ ${vp.width}x${vp.height}: the fares card is whole and nothing sits under it`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto(p.url);
      await expect(page.locator('.route-hero .opt-private')).toBeVisible();

      // (a) the card's own bottom edge: CTA and fine print are not clipped by the hero
      for (const sel of ['.route-hero .opt-private a.opt-cta', '.route-hero .opt-private .fares-fine']) {
        const r = await hitTest(page, sel, 0, 'bottom');
        expect(r.ok, `${sel} is not hit-testable at its own bottom edge — ${r.why}`).toBe(true);
      }

      // (b) nothing under the hero is run over by the overhanging card
      await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));
      const selectors = ['.trip-trust li', ...(p.privateOnly ? ['p.no-share'] : [])];
      const collisions = await page.evaluate((sels) => {
        const c = document.querySelector('.route-hero .opt-private').getBoundingClientRect();
        const out = [];
        for (const sel of sels) {
          for (const el of document.querySelectorAll(sel)) {
            const r = el.getBoundingClientRect();
            if (r.top < c.bottom && r.bottom > c.top && r.left < c.right && r.right > c.left) {
              out.push(`${sel}: "${el.textContent.trim().slice(0, 40)}"`);
            }
          }
        }
        return out;
      }, selectors);
      expect(collisions, 'these overlap the fares card').toEqual([]);

      for (const sel of selectors) {
        const n = await page.locator(sel).count();
        expect(n, `${sel} rendered nothing`).toBeGreaterThan(0);
        for (let i = 0; i < n; i++) {
          const r = await hitTest(page, sel, i, 'right');
          expect(r.ok, `${sel} #${i} is not hit-testable at its right edge — ${r.why}`).toBe(true);
        }
      }

      // (c) nothing pushes the document sideways
      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    });
  }

  /* The BODY sections (task B2). Each one is a two-column grid or a 4-up card row that
     collapses on a phone, and every one of them can fail the same two ways: a column that
     does not shrink pushes the page sideways, and a card whose image is sized by its
     INTRINSIC height attribute instead of its box grows a gap between the photo and the
     text under it. Neither shows in a unit test. */
  for (const vp of [{ width: 1280, height: 900 }, { width: 375, height: 812 }]) {
    test(`${p.name} @ ${vp.width}x${vp.height}: the body sections fit and the FAQ opens`, async ({ page }) => {
      await page.setViewportSize(vp);
      await page.goto(p.url);
      await expect(page.locator('.drive ol.stops')).toBeVisible();

      // every section renders, and renders INSIDE the viewport
      const boxes = await page.evaluate(() => {
        const out = {};
        for (const sel of ['.drive', '.included', '.proof', '.faq', '.next']) {
          const el = document.querySelector(sel);
          if (!el) { out[sel] = null; continue; }
          const r = el.getBoundingClientRect();
          out[sel] = { left: Math.round(r.left), right: Math.round(r.right), w: window.innerWidth };
        }
        return out;
      });
      for (const [sel, box] of Object.entries(boxes)) {
        expect(box, `${sel} rendered nothing`).not.toBeNull();
        expect(box.left, `${sel} starts left of the viewport`).toBeGreaterThanOrEqual(-1);
        expect(box.right, `${sel} runs past the right edge (${box.right} > ${box.w})`).toBeLessThanOrEqual(box.w + 1);
      }

      // a where-next card's photo and its text block touch — no inherited grid gap between them
      const gaps = await page.evaluate(() => [...document.querySelectorAll('.next a.rt-card')].map((c) => {
        const img = c.querySelector('img').getBoundingClientRect();
        const bd = c.children[c.children.length - 1].getBoundingClientRect();
        return Math.round((bd.top - img.bottom) * 100) / 100;
      }));
      expect(gaps.length).toBeGreaterThan(0);
      for (const g of gaps) expect(Math.abs(g), `card photo and text are ${g}px apart`).toBeLessThanOrEqual(1);

      // the accordion is a real <details>: the second one is shut, and clicking opens it
      const second = page.locator('.faq details').nth(1);
      await expect(second).toHaveJSProperty('open', false);
      await second.locator('summary').click();
      await expect(second).toHaveJSProperty('open', true);

      const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(over, 'the page scrolls sideways').toBeLessThanOrEqual(0);
    });
  }

  test(`${p.name}: on a phone the price and the Book button are above the fold`, async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await page.goto(p.url);
    await expect(page.locator('.route-hero .opt-private')).toBeVisible();
    await page.evaluate(() => window.scrollTo({ top: 0, left: 0, behavior: 'instant' }));

    for (const sel of ['.route-hero .opt-private [data-fare="car"]', '.route-hero .opt-private a.opt-cta']) {
      const bottom = await page.locator(sel).first().evaluate((el) => el.getBoundingClientRect().bottom);
      expect(Math.round(bottom), `${sel} falls below the first 812px of the page`).toBeLessThanOrEqual(812);
    }
  });
}
