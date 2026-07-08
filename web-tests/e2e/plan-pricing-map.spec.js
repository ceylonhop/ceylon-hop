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

test('planner prices country-suffixed popular places without waiting for Google', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kalpitiya%2C%20Sri%20Lanka%7CJaffna%7CTrincomalee&pax=2&vehicle=car');

  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  const firstLegDistance = page.locator('#rail .leg-card').first().locator('[data-dist]');
  await expect(firstLegDistance).toContainText('km');
  await expect(firstLegDistance).toContainText('from $');
  await expect(firstLegDistance).not.toContainText('Pick both points');
  await expect(page.locator('#st-drive')).toContainText('km');
});

test('planner guide range never rounds a priced car transfer down to zero', async ({ page }) => {
  await gotoBooking(page, {
    path: '/plan.html',
    query: 'stops=Yatiyanthota%2C%20Sri%20Lanka%7CRatnapura%2C%20Sri%20Lanka&pax=2&vehicle=car',
    routeKm: 52,
  });

  await expect(page.locator('#rail [data-dist]')).toContainText('52 km');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $29');
  await expect(page.locator('#sum-amt')).toHaveText(/\$29[-\u2013]\$50/);
  await expect(page.locator('#sum-amt')).not.toContainText('$0');
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
