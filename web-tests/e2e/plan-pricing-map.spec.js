import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

test('planner prices Kandy to Ella with the shared route table', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
  await expect(page.locator('#rail [data-dist]')).toContainText('136 km');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $69');
  await expect(page.locator('#st-drive')).toContainText('136 km');
  await expect(page.locator('#sum-amt')).toHaveText(/\$50[-\u2013]\$100/);
});

test('search add-stops handoff preserves the equivalent base route price', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=kandy&to=ella&pax=2' });

  await expect(page.locator('a[href*="price=69"][href*="vehicle=car"]').first()).toBeVisible();
  await page.locator('#add-stops').click();
  await page.waitForURL('**/plan.html?**');

  await expect(page.locator('#rail [data-dist]')).toContainText('136 km');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $69');
  await expect(page.locator('#sum-amt')).toHaveText(/\$50[-\u2013]\$100/);
});

test('planner fallback map keeps repeated stops in the visible route order', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla%7CKandy&pax=2&vehicle=car');

  const map = page.locator('#trip-map');
  await expect(map.locator('.tm-pin-num')).toHaveCount(3);
  await expect(map.locator('.tm-pin-num').nth(0)).toHaveText('1');
  await expect(map.locator('.tm-pin-num').nth(1)).toHaveText('2');
  await expect(map.locator('.tm-pin-num').nth(2)).toHaveText('3');
  await expect(map.locator('.tm-pin-label', { hasText: 'Kandy' })).toHaveCount(2);
});
