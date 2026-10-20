import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/* Google Maps is OFF by default on test sites (localhost, LAN, staging). September 2026's $122
   Maps bill was ~75% this suite: every CI run loaded ~19 real maps and ~29 real route queries
   because the live browser key accepts localhost, and only some specs blocked Google. ch-map.js
   now refuses to load Google there unless the tab opts in (?maps=1, or the "Turn on" pill),
   so these specs pass a REAL page, with no Google stub, and count what reaches Google.
   Every Google request is aborted, so even a failing run here costs nothing. */

// The BILLED Maps hosts only — Google Fonts (fonts.googleapis.com) and sign-in (gstatic) are free.
const GOOGLE_HOST = /^(maps|routes|places)\.googleapis\.com$|^maps\.gstatic\.com$/;
const BOOKING = '/booking.html?mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car';

async function countGoogle(page) {
  const hits = [];
  await page.route((url) => GOOGLE_HOST.test(url.hostname), (r) => { hits.push(r.request().url()); return r.abort(); });
  return hits;
}

// Playwright's Chromium reports navigator.webdriver = true, and the pill stays hidden for
// automation so it can never sit on top of what another spec is measuring or clicking.
async function asHuman(page) {
  await page.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => false }));
}

test('booking on a test site draws the offline map and never calls Google', async ({ page }) => {
  const hits = await countGoogle(page);
  await blockLiveApi(page);
  await page.goto(BOOKING);
  // The drawn map is in place (it sits on step 2, so it is attached rather than on screen).
  await expect(page.locator('#rm-canvas svg')).toHaveCount(1);
  // A hotel name is exactly what would ask Google Places for suggestions on a live site.
  await page.evaluate(() => window.goStep && window.goStep(2));
  await page.fill('#loc-to', 'Cinnamon Grand');
  await page.waitForTimeout(800);
  expect(hits).toEqual([]);
  await expect(page.locator('#ch-maps-live')).toHaveCount(0); // automation: no pill
});

test('the trip planner on a test site never calls Google', async ({ page }) => {
  const hits = await countGoogle(page);
  await blockLiveApi(page);
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(800);
  expect(hits).toEqual([]);
});

test('?maps=1 turns live maps on for this tab, and ?maps=0 turns them off again', async ({ page }) => {
  const hits = await countGoogle(page);
  await blockLiveApi(page);
  await page.goto(BOOKING + '&maps=1');
  await expect.poll(() => hits.length).toBeGreaterThan(0);

  // Remembered for the tab: the next page asks Google without the parameter.
  const before = hits.length;
  await page.goto(BOOKING);
  await expect.poll(() => hits.length).toBeGreaterThan(before);

  await page.goto(BOOKING + '&maps=0');
  await expect(page.locator('#rm-canvas svg')).toHaveCount(1);
  const off = hits.length;
  await page.waitForTimeout(800);
  expect(hits.length).toBe(off);
});

test('a person on a test site gets a pill that turns live maps on and off', async ({ page }) => {
  const hits = await countGoogle(page);
  await asHuman(page);
  await blockLiveApi(page);
  await page.goto(BOOKING);
  const pill = page.locator('#ch-maps-live');
  await expect(pill).toContainText('Google Maps off');
  expect(hits).toEqual([]);

  await pill.getByRole('button', { name: 'Turn on' }).click();
  await expect(pill).toContainText('Google Maps on');
  await expect.poll(() => hits.length).toBeGreaterThan(0);

  await pill.getByRole('button', { name: 'Turn off' }).click();
  await expect(pill).toContainText('Google Maps off');
});
