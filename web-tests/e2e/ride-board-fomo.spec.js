import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// FOMO rows (plan 2026-10-19-ride-board-fomo): a gathering ride says how many seats it still
// needs, when names close, and what the same trip costs in a private car; its open seats show
// as dashed faces. The clock is pinned so the countdown is exact.
const NOW = '2099-08-10T00:00:00.000Z';
const member = (n, c) => ({ firstName: n, country: c, photoUrl: null });
const ride = (o) => ({ corridorId: 'ella-south', from: 'Ella', to: 'Mirissa', slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2800, status: 'gathering', note: null, lockedTime: null, ...o });
const LISTS = [
  ride({ code: 'FO-1', date: '2099-08-12', cutoffAt: '2099-08-10T09:12:00.000Z', committed: 2, members: [member('Tom', 'GB'), member('Lea', 'FR')] }),
  ride({ code: 'FO-2', date: '2099-08-20', cutoffAt: '2099-08-18T01:30:00.000Z', committed: 1, members: [member('Sam', 'CA')] }),
  ride({ code: 'FO-3', date: '2099-08-11', cutoffAt: '2099-08-09T01:30:00.000Z', status: 'confirmed', committed: 3,
    members: [member('Ann', 'PL'), member('Yuki', 'JP'), member('Ben', 'IE')] }),
];

async function stubApi(page, lists = LISTS) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

async function open(page) {
  await page.clock.setFixedTime(new Date(NOW));
  await stubApi(page);
  await page.goto('/board.html');
  await expect(page.locator('.rw[data-code="FO-1"]')).toBeVisible({ timeout: 15000 });
}

test.describe('on a phone', () => {
  test.use({ viewport: { width: 375, height: 812 } });

  test('a ride one short says so, runs a red clock and shows its open seat', async ({ page }) => {
    await open(page);
    const row = page.locator('.rw[data-code="FO-1"]');
    await expect(row.locator('.rw-togo')).toHaveText('1 seat to go');
    await expect(row.locator('.rw-togo')).toHaveClass(/hot/);
    // on a phone the closing line rides on the time line, not under the pill — in its short form
    await expect(row.locator('.rw-when .rw-close')).toHaveText('Closes in 9h 12m');
    await expect(row.locator('.rw-when .rw-close')).toHaveClass(/urgent/);
    await expect(row.locator('.rw-state .rw-close')).toBeHidden();
    await expect(row.locator('.rw-open')).toHaveCount(1);
    await expect(row.locator('.rw-vs')).toHaveText(/^vs \$\d+(\.\d{2})? private car$/);
  });

  test('a ride further out gives its Sri Lanka closing date, calmly', async ({ page }) => {
    await open(page);
    const row = page.locator('.rw[data-code="FO-2"]');
    await expect(row.locator('.rw-togo')).toHaveText('2 seats to go');
    await expect(row.locator('.rw-togo')).not.toHaveClass(/hot/);
    // 01:30 UTC on the 18th is 07:00 on the 18th in Colombo
    await expect(row.locator('.rw-when .rw-close')).toHaveText('Closes 18 Aug');
    await expect(row.locator('.rw-open')).toHaveCount(2);
  });

  test('a confirmed ride keeps its locked state — no seats to go, no comparison', async ({ page }) => {
    await open(page);
    const row = page.locator('.rw[data-code="FO-3"]');
    await expect(row.locator('.rw-togo')).toHaveCount(0);
    await expect(row.locator('.rw-vs')).toHaveCount(0);
    await expect(row.locator('.rw-state')).toContainText('Locked in');
  });

  test('a FOMO row stays inside the screen', async ({ page }) => {
    await open(page);
    const over = await page.locator('.rw[data-code="FO-1"]').evaluate((el) => el.scrollWidth > el.clientWidth + 1);
    expect(over).toBe(false);
    const pageOver = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
    expect(pageOver).toBe(false);
  });
});

for (const width of [768, 1020, 1280]) {
  test(`at ${width}px the seat state never runs into the price or the actions`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await open(page);
    const hit = (x, y) => x.x < y.x + y.width && y.x < x.x + x.width && x.y < y.y + y.height && y.y < x.y + x.height;
    for (const code of ['FO-1', 'FO-2']) {
      const row = page.locator(`.rw[data-code="${code}"]`);
      const s = await row.locator('.rw-state').boundingBox();
      const p = await row.locator('.rw-price').boundingBox();
      const a = await row.locator('.rw-acts').boundingBox();
      expect(hit(s, p), `${code}: state overlaps price`).toBe(false);
      expect(hit(s, a), `${code}: state overlaps actions`).toBe(false);
    }
  });
}
