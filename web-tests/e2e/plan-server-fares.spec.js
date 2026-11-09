import { test, expect } from '@playwright/test';
import { blockLiveApi } from './_stubs.js';

/*
  The planner shows the engine's fare for every catalogue drive, so it says what booking charges.

  It used to price each drive itself from the distance the visitor's browser got from Google, while
  booking charges what the API measures with its own Google lookup. The two disagree by a few km,
  so prod showed Negombo → Colombo → Anuradhapura at $105 in the planner and $99.99 at booking
  (248 km vs 242 km), and Colombo → Anuradhapura at $89.99 vs $88 (209 km vs 206 km).

  Now the existing estimate-batch also asks for each drive's fare, car and van in one request (the
  API memoises a batch's distances, so the second vehicle bills no extra Google lookup). The
  page's own formula stays as the fallback until the answer lands, or if it never does.
*/

const FARES = { car: 9999, van: 13900 };

// Answers every intent with its vehicle's fare, and records each request body.
async function stubFares(page, fares = FARES) {
  const bodies = [];
  await page.route('**/quote/v2/estimate-batch', async (r) => {
    const body = JSON.parse(r.request().postData() || '{}');
    bodies.push(body);
    const results = (body.intents || []).map((i) => ({ totalCents: fares[i.vehicle], currency: 'USD' }));
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ results }) });
  });
  return bodies;
}

test.beforeEach(async ({ page }) => {
  await blockLiveApi(page);
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
});

const price = (page) => page.locator('#rail .leg-card').first().locator('[data-dist] .lm-price b');

test('a plain drive shows the engine fare, and the van fare after switching', async ({ page }) => {
  const bodies = await stubFares(page);
  await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car');
  await expect(price(page)).toHaveText('$99.99');
  await page.locator('.veh-btn[data-veh="van"]').click();
  await expect(price(page)).toHaveText('$139');
  // Both vehicles came from the one request: switching asked nothing new.
  const intents = bodies.flatMap((b) => b.intents);
  expect(intents.map((i) => i.vehicle).sort()).toEqual(['car', 'van']);
});

test('a drive with a stop is asked for as one ride and shows its engine fare', async ({ page }) => {
  const bodies = await stubFares(page);
  await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Sigiriya / Dambulla|Ella') + '&nights=0,0,0&through=0&pax=2&vehicle=car');
  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
  await expect(price(page)).toHaveText('$99.99');
  const intents = bodies.flatMap((b) => b.intents);
  const ride = intents.find((i) => i.vehicle === 'car');
  expect(ride.legs).toEqual([{ from: 'Kandy', to: 'Ella', via: ['Sigiriya / Dambulla'] }]);
  // A ride with stops has no road choice, so it never asks for one (ops GC-10).
  expect(intents.some((i) => i.compareRoutes)).toBe(false);
});

test('no answer keeps the page\'s own price', async ({ page }) => {
  await page.goto('/plan.html?stops=' + encodeURIComponent('Kandy|Ella') + '&pax=2&vehicle=car');
  const expected = await page.evaluate(() => {
    const T = window.TRANSFERS;
    return '$' + String(T.finishPrice(T.legPrice(T.privateQuote('kandy', 'ella').km, 'car'), T.FLOORS.car));
  });
  await page.waitForTimeout(1200);   // past the 800 ms batch debounce: blockLiveApi answered 404
  await expect(price(page)).toHaveText(expected);
});
