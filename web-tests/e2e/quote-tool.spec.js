import { test, expect } from '@playwright/test';

// The internal quoting tool is served by the API (not the static site), so these specs use an
// absolute URL to the API's /admin/quote page. The API web server is started by playwright.config.js.
const TOOL = 'http://localhost:8787/admin/quote';

test('autocomplete → auto-distance → priced quote (server-side, no Google key)', async ({ page }) => {
  await page.goto(TOOL);
  await expect(page.locator('h1')).toContainText('Ceylon Hop');

  // Type a partial place → the server-side /places autocomplete suggests it.
  const from = page.locator('.leg [data-f="from"]').first();
  await from.click();
  await from.fill('Kand');
  const kandy = page.locator('.leg .acmenu .acitem', { hasText: 'Kandy' }).first();
  await expect(kandy).toBeVisible();
  await kandy.click();
  await expect(from).toHaveValue('Kandy');

  const to = page.locator('.leg [data-f="to"]').first();
  await to.click();
  await to.fill('Ella');
  await page.locator('.leg .acmenu .acitem', { hasText: 'Ella' }).first().click();
  await expect(to).toHaveValue('Ella');

  // Distance auto-fills from the server (/distance).
  const dist = page.locator('.leg [data-f="distanceKm"]').first();
  await expect(dist).not.toHaveValue('');

  // Price it.
  await page.fill('#name', 'E2E');
  await page.click('#go');
  await expect(page.locator('.total')).toContainText('LKR');
  await expect(page.locator('#draftBox')).toContainText('Kandy');
  // Car-vs-van comparison rendered.
  await expect(page.locator('.cmp')).toHaveCount(2);
});

test('an unknown place with no manual km shows an error (never a silent/blank quote)', async ({ page }) => {
  await page.goto(TOOL);
  await page.locator('.leg [data-f="from"]').first().fill('Nowhereville');
  await page.locator('.leg [data-f="to"]').first().fill('Kandy');
  await page.locator('#name').click(); // blur the location field so its autocomplete menu closes
  await expect(page.locator('.leg .acmenu.on')).toHaveCount(0);
  await page.click('#go');
  await expect(page.locator('.err')).toBeVisible();
  await expect(page.locator('.total')).toHaveCount(0);
});

test('a manual distance prices without needing the maps lookup', async ({ page }) => {
  await page.goto(TOOL);
  await page.locator('.leg [data-f="from"]').first().fill('Somewhere Villa');
  await page.locator('.leg [data-f="to"]').first().fill('Airport');
  await page.locator('.leg [data-f="distanceKm"]').first().fill('80');
  await page.click('#go');
  await expect(page.locator('.total')).toContainText('LKR');
});
