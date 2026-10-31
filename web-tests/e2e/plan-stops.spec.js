import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

const VIEWPORTS = [
  { name: 'phone', viewport: { width: 375, height: 812 }, hasTouch: true, isMobile: true },
  { name: 'tablet', viewport: { width: 768, height: 1024 } },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

const CHAIN = 'Kandy|Sigiriya / Dambulla|Ella';
const url = (extra = '') => '/plan.html?stops=' + encodeURIComponent(CHAIN) + '&nights=0,0,0&through=0&pax=2&vehicle=car' + extra;

for (const vp of VIEWPORTS) {
  test.describe(vp.name, () => {
    test.use({ viewport: vp.viewport, hasTouch: !!vp.hasTouch, isMobile: !!vp.isMobile });

    test('loads a through wire as one leg with a stop row', async ({ page }) => {
      await page.goto(url());
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveValue('Sigiriya / Dambulla');
      await expect(page.locator('#st-stops')).toHaveText('3');
      await expect(page.locator('#st-legs')).toHaveText('1');
      await expect(page.locator('#sum-route')).toContainText('Kandy');
      await expect(page.locator('#sum-route')).toContainText('Ella');
      // no horizontal overflow at this width
      const over = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
      expect(over).toBe(false);
    });

    test('hands the stop to booking as through, and back again on edit', async ({ page }) => {
      await page.goto(url());
      await page.locator('#request-btn').click();
      await page.locator('#dates-continue').click();
      await page.waitForURL('**/booking.html?**');
      const q = new URL(page.url()).searchParams;
      expect(q.get('stops')).toBe(CHAIN);
      expect(q.get('through')).toBe('0');
      await page.locator('.tr-edit').click();
      await page.waitForURL('**/plan.html?**');
      await expect(page.locator('#rail .leg-card')).toHaveCount(1);
      await expect(page.locator('#rail .leg-via')).toHaveCount(1);
    });
  });
}

test('kill switch off: the same URL loads as two plain legs and offers no add-stop link', async ({ page }) => {
  await page.addInitScript(() => { window.__CH_PLANNER_STOPS_OFF = true; });
  await page.goto(url());
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await expect(page.locator('.add-via')).toHaveCount(0);
});

// `ack` is a wire index, like `through` and `gaps`: the run whose HEAD wire it names. Two runs —
// Kandy→Sigiriya→Ella (wires 0,1) and Ella→Galle (wire 2) — so ack=2 is the SECOND leg, not leg 2.
test('ack names the head wire of a run and round-trips to booking unchanged', async ({ page }) => {
  const stops = 'Kandy|Sigiriya / Dambulla|Ella|Galle';
  await page.goto('/plan.html?stops=' + encodeURIComponent(stops) + '&nights=0,0,0,0&through=0&ack=2&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('stops')).toBe(stops);
  expect(q.get('through')).toBe('0');
  expect(q.get('ack')).toBe('2');
});

// `dates` is per WIRE too: every wire of a run carries its leg's date. Kandy→Sigiriya→Ella
// (wires 0,1) is on 12-01 and Ella→Galle (wire 2) on 12-03, so the second leg reads dates[2].
test('dates are read by each leg\'s head wire and round-trip to booking unchanged', async ({ page }) => {
  const stops = 'Kandy|Sigiriya / Dambulla|Ella|Galle';
  const dates = '2026-12-01,2026-12-01,2026-12-03';
  await page.goto('/plan.html?stops=' + encodeURIComponent(stops) + '&nights=0,0,0,0&through=0&dates=' + dates + '&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');
  const q = new URL(page.url()).searchParams;
  expect(q.get('through')).toBe('0');
  expect(q.get('dates')).toBe(dates);
});
