import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// index.html pings the live API on load — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// The "Popular transfers" cards are photo-first (option A, 2026-10-24). At every grid width —
// 3-up, 2-up and 1-up, down to the narrowest phone the site supports — each card must show a
// loaded destination photo, keep its chips inside the photo, and wrap the longest route name
// ("Colombo Airport (CMB) → Sigiriya / Dambulla") without clipping or pushing the price row
// out of the card.
const WIDTHS = [1280, 1000, 800, 390, 320];

for (const width of WIDTHS) {
  test(`cards carry a photo and nothing overflows at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto('/index.html');

    const cards = page.locator('#home-transfers .tcard');
    await expect(cards).toHaveCount(6);
    await cards.last().scrollIntoViewIfNeeded();

    for (let i = 0; i < 6; i++) {
      const card = cards.nth(i);
      await card.scrollIntoViewIfNeeded();
      // site.js reveals cards with a 0.7s translateY transition; the geometry below is read in
      // several calls, so wait for the card to come to rest or the reads straddle the slide.
      await expect.poll(() => card.evaluate((el) => {
        const cs = getComputedStyle(el);
        return cs.opacity === '1' && cs.transform === 'none';
      })).toBe(true);

      // the photo is real and has loaded (lazy, so wait for it once in view)
      const img = card.locator('.tc-img');
      await expect(img).toBeVisible();
      await expect.poll(() => img.evaluate((el) => el.complete && el.naturalWidth)).toBeGreaterThan(0);

      const box = await card.boundingBox();
      const ph = await card.locator('.tc-ph').boundingBox();
      const route = await card.locator('.tc-route').boundingBox();
      const foot = await card.locator('.tc-foot').boundingBox();
      expect(box && ph && route && foot).toBeTruthy();

      // photo spans the card's full width and sits at the top — inside the 1px border that
      // .bg-postcard .card draws (site.css), hence the 2px allowance on width
      expect(Math.abs(ph.x - box.x)).toBeLessThanOrEqual(1);
      expect(Math.abs(ph.width - box.width)).toBeLessThanOrEqual(2);
      expect(Math.abs(ph.y - box.y)).toBeLessThanOrEqual(1);

      // chips stay inside the photo
      for (const chip of await card.locator('.tc-meta, .tc-shared').all()) {
        const c = await chip.boundingBox();
        expect(c.x).toBeGreaterThanOrEqual(ph.x);
        expect(c.x + c.width).toBeLessThanOrEqual(ph.x + ph.width + 1);
        expect(c.y).toBeGreaterThanOrEqual(ph.y);
        expect(c.y + c.height).toBeLessThanOrEqual(ph.y + ph.height + 1);
      }

      // route text wraps instead of clipping, and the price row stays inside the card
      const clipped = await card.locator('.tc-route').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
      expect(clipped).toBe(false);
      expect(route.y).toBeGreaterThanOrEqual(ph.y + ph.height);
      expect(foot.y).toBeGreaterThanOrEqual(route.y + route.height);
      expect(foot.y + foot.height).toBeLessThanOrEqual(box.y + box.height + 1);
      expect(foot.x + foot.width).toBeLessThanOrEqual(box.x + box.width + 1);
    }

    // the 3-up / 2-up / 1-up grid rows line up: cards in one row share a bottom edge
    const boxes = await cards.evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom) }; }));
    const rows = new Map();
    for (const b of boxes) rows.set(b.top, [...(rows.get(b.top) || []), b.bottom]);
    for (const bottoms of rows.values()) expect(Math.max(...bottoms) - Math.min(...bottoms)).toBeLessThanOrEqual(1);
  });
}
