import { test, expect } from '@playwright/test';

test('old /trip/ URL redirects to the new route page', async ({ page }) => {
  await page.goto('/trip/kandy_to_ella/');            // old underscore stub
  await expect(page).toHaveURL(/\/trip\/kandy-to-ella\/?$/);
  await expect(page.locator('h1')).toContainText('Kandy to Ella');
});

test('old marketing URL redirects to its new page', async ({ page }) => {
  await page.goto('/about-us/');
  await expect(page).toHaveURL(/\/about\.html$/);
});

test('unknown URL serves the branded 404', async ({ page }) => {
  const res = await page.goto('/no-such-page-xyz/');
  expect(res.status()).toBe(404);
  // The branded 404 headline is "You've wandered off the map" (the page <title> still
  // reads "Page not found — Ceylon Hop"); match the visible h1 copy.
  await expect(page.locator('h1')).toContainText('wandered off the map');
});
