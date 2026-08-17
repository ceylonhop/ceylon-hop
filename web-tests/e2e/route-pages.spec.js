import { test, expect } from '@playwright/test';

test('route page renders with nav, prices, and a working search CTA', async ({ page }) => {
  await page.goto('/trip/kandy-to-ella/');
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
  await expect(page.locator('.route-hero .sub')).toContainText('Approx. 135 km · 3h 45m');
  await expect(page.locator('.faq-q').first()).toContainText('approx. 135 km · 3h 45m');
  await expect(page.locator('.nav-links')).toBeVisible();
  await expect(page.getByText('from $59').first()).toBeVisible();
  await page.getByRole('link', { name: /see prices|book/i }).first().click();
  await expect(page).toHaveURL(/search\.html\?from=kandy&to=ella/);
});

test('/trip/ index lists route cards that link to pages', async ({ page }) => {
  await page.goto('/trip/');
  await expect(page.locator('h1')).toContainText('Sri Lanka transfer routes');
  const card = page.getByRole('link', { name: /Kandy → Ella/ }).first();
  await expect(card).toBeVisible();
  await expect(card).toContainText('Approx. 135 km · 3h 45m');
  await card.click();
  await expect(page).toHaveURL(/\/trip\/kandy-to-ella\/?$/);
});

test('compact route estimates stay readable without mobile overflow', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.goto('/trip/kandy-to-ella/');

  await expect(page.locator('.route-hero .sub')).toContainText('Approx. 135 km · 3h 45m');
  await expect(page.locator('.rt-card').first()).toContainText('Approx. 135 km · 3h 45m');
  expect(await page.locator('body').evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});
