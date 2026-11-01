import { test, expect } from '@playwright/test';
import { isApiRequest } from './_api-host.js';

// Landing on one ride from the home page (plan 2026-10-19-ride-board-fomo, PR 2): ?hl=CODE
// tints that ride and brings it into view. No sheet opens, no filter is set.
const member = (n, c) => ({ firstName: n, country: c, photoUrl: null });
const ride = (code, date) => ({ code, corridorId: 'hill-line', from: 'Kandy', to: 'Ella', date, slot: 'morning', minSeats: 3, capacity: 6,
  seatPrice: 2100, status: 'gathering', note: null, lockedTime: null, cutoffAt: '2099-12-20T01:30:00.000Z', committed: 1, members: [member('Sam', 'CA')] });
// Eight rides on eight days, so the last one sits well below the first screen on a phone.
const LISTS = Array.from({ length: 8 }, (_, i) => ride('HL-' + (i + 1), '2099-12-' + String(22 + i).padStart(2, '0')));

async function stubApi(page) {
  await page.route((u) => isApiRequest(u), (route) => {
    const p = new URL(route.request().url()).pathname;
    if (p === '/board') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ lists: LISTS }) });
    if (p === '/board/me') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ me: null }) });
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test.use({ viewport: { width: 375, height: 812 } });

test('?hl=CODE tints that ride and scrolls it into view, without opening its sheet', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html?hl=HL-8');
  const row = page.locator('.rw[data-code="HL-8"]');
  await expect(row).toHaveClass(/\bhl\b/, { timeout: 15000 });
  await expect(page.locator('.rw[data-code="HL-1"]')).not.toHaveClass(/\bhl\b/);
  await expect(page.locator('body')).not.toHaveClass(/detail-open/);
  const box = await row.boundingBox();
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(812);
});

test('an unknown code is harmless', async ({ page }) => {
  await stubApi(page);
  await page.goto('/board.html?hl=NOPE-1');
  await expect(page.locator('.rw[data-code="HL-1"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rw.hl')).toHaveCount(0);
});

test('a code that is not a plain code (a quote in it) cannot break the board', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await stubApi(page);
  await page.goto('/board.html?hl=' + encodeURIComponent('HL-8"]x'));
  await expect(page.locator('.rw[data-code="HL-1"]')).toBeVisible({ timeout: 15000 });
  await expect(page.locator('.rw.hl')).toHaveCount(0);
  expect(errors).toEqual([]);
});
