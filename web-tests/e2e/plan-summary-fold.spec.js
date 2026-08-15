import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

// plan.html pings the live API on load — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// The desktop trip summary is sticky, and it is only useful if the WHOLE card — the
// "Next: add your dates" CTA included — is on screen once it sticks. `--map-h` (plan.html)
// is the knob that spends that budget: every pixel the map grows is a pixel the CTA moves
// down. Nothing guarded the trade before the map was raised to 22vh, so this pins it.
//
// 1280x720 is the tightest window that still gets the main branch — at 700px and below a
// media query swaps in a shorter map and a smaller sticky offset.
const STOPS = ['Colombo Airport (CMB)', 'Negombo', 'Sigiriya', 'Kandy', 'Ella', 'Yala', 'Mirissa'];

test('the stuck trip summary keeps its CTA above the fold', async ({ page }) => {
  // No Google map: the SVG island falls back into the same host, and the summary forces
  // whatever lands there to --map-h — so the fold budget is identical either way, offline.
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.goto('/plan.html?stops=' + encodeURIComponent(STOPS.join('|')));

  const summary = page.locator('.summary');
  await expect(summary).toBeVisible();

  // Far enough in that the card is pinned, but not so far that its column has run out —
  // sticky only holds inside the containing block, and past ~1000px the summary scrolls
  // away with the itinerary by design.
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: 'instant' }));

  const fit = await page.evaluate(() => {
    const s = document.querySelector('.summary').getBoundingClientRect();
    return { top: Math.round(s.top), bottom: Math.round(s.bottom), vh: window.innerHeight };
  });
  // Pinned at its sticky offset, not still riding the page.
  expect(fit.top).toBe(86);
  expect(fit.bottom, `summary bottom ${fit.bottom} must clear the ${fit.vh}px fold — lower --map-h in plan.html`)
    .toBeLessThanOrEqual(fit.vh);

  await expect(page.locator('#request-btn')).toBeInViewport();
});

// The knob itself: a regression that drops the map back to a letterbox is as much a bug as
// one that pushes the CTA off screen, so pin both ends of the range it may live in.
test('the summary map is tall enough to frame the island', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.setViewportSize({ width: 1280, height: 800 });
  await page.goto('/plan.html?stops=' + encodeURIComponent(STOPS.slice(0, 3).join('|')));

  await expect(page.locator('.summary')).toBeVisible();
  const h = await page.evaluate(() => Math.round(document.querySelector('.trip-map').getBoundingClientRect().height));
  expect(h).toBeGreaterThanOrEqual(160);
  expect(h).toBeLessThanOrEqual(200);
});
