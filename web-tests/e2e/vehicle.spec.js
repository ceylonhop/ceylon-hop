import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

test('4 travellers prompts a van upgrade and blocks Next until resolved', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(3)); // Travelers panel
  await page.evaluate(() => { window.step('ad', 1); window.step('ad', 1); window.step('ad', 1); }); // 1 -> 4

  await expect(page.locator('#cap-note')).toBeVisible();
  await expect(page.locator('#cap-note')).toContainText('Switch to AC van');
  await expect(page.locator('#n4')).toBeDisabled();

  await page.evaluate(() => window.switchToVan());
  await expect(page.locator('#sum-adlabel')).toHaveText('AC van (up to 6)');
  await expect(page.locator('#n4')).toBeEnabled();
});

test('dropping back below 4 recommends the cheaper car (with savings) and re-prices', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(3));
  // up to 4 -> van, then back down to 3
  await page.evaluate(() => { window.step('ad', 1); window.step('ad', 1); window.step('ad', 1); });
  await page.evaluate(() => window.switchToVan());
  await page.evaluate(() => window.step('ad', -1)); // 4 -> 3

  const note = page.locator('#cap-note');
  await expect(note).toBeVisible();
  await expect(note).toContainText('Switch to AC car');
  await expect(note).toContainText('save $');

  await page.evaluate(() => window.switchToCar());
  await expect(page.locator('#sum-adlabel')).toHaveText('AC car (up to 3)');
  await expect(page.locator('#cap-note')).toHaveText('');
  await expect(page.locator('#n4')).toBeEnabled();
});
