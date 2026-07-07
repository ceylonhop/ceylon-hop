import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

test('mobile booking shows the price summary before the active payment panel', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);
  await fillContact(page);

  const summary = await page.locator('#summary').boundingBox();
  const panel = await page.locator('.panel[data-panel="4"]').boundingBox();
  expect(summary).toBeTruthy();
  expect(panel).toBeTruthy();
  expect(summary.y).toBeLessThan(panel.y);
  await expect(page.locator('#sum-total')).toBeVisible();
  await expect(page.locator('#pay-due')).toBeVisible();
});

test('mobile terms consent has a reliable touch target and can be checked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);
  await fillContact(page);

  const inputBox = await page.locator('#agree').boundingBox();
  const labelBox = await page.locator('label:has(#agree)').boundingBox();
  expect(inputBox).toBeTruthy();
  expect(labelBox).toBeTruthy();
  expect(inputBox.width).toBeGreaterThanOrEqual(22);
  expect(inputBox.height).toBeGreaterThanOrEqual(22);
  expect(labelBox.height).toBeGreaterThanOrEqual(48);

  await page.locator('#agree').uncheck();
  await page.locator('label:has(#agree)').click();
  await expect(page.locator('#agree')).toBeChecked();
});
