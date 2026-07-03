import { test, expect } from '@playwright/test';

// M17: front-end errors beacon to /errors/client. sendBeacon is disabled in the test so
// the snippet takes its fetch fallback, which Playwright can intercept deterministically.

const arm = async (page) => {
  const hits = [];
  await page.addInitScript(() => { delete navigator.__proto__.sendBeacon; navigator.sendBeacon = undefined; });
  await page.route('**/errors/client', async (route) => {
    hits.push(JSON.parse(route.request().postData() || '{}'));
    await route.fulfill({ status: 204, body: '' });
  });
  return hits;
};

test('a window error on a route page beacons to /errors/client', async ({ page }) => {
  const hits = await arm(page);
  await page.goto('/trip/kandy-to-ella/');
  await page.evaluate(() => setTimeout(() => { throw new Error('e2e-boom'); }, 0));
  await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  expect(hits[0].message).toContain('e2e-boom');
  expect(hits[0].url).toContain('/trip/kandy-to-ella/');
});

test('beacons are capped at 5 per page (hot-loop protection)', async ({ page }) => {
  const hits = await arm(page);
  await page.goto('/terms.html');
  await page.evaluate(() => {
    for (let i = 0; i < 9; i++) setTimeout(() => { throw new Error('loop-' + i); }, 0);
  });
  await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  await page.waitForTimeout(800); // let any stragglers land
  expect(hits.length).toBeLessThanOrEqual(5);
});

test('unhandled promise rejections beacon too', async ({ page }) => {
  const hits = await arm(page);
  await page.goto('/trip/');
  await page.evaluate(() => { Promise.reject(new Error('e2e-rejection')); });
  await expect.poll(() => hits.length, { timeout: 5000 }).toBeGreaterThanOrEqual(1);
  expect(hits[0].message).toContain('e2e-rejection');
});
