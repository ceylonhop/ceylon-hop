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

test('mobile progress steps keep descriptive labels visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);

  const labels = page.locator('#psteps .lbl');
  await expect(labels.nth(0)).toContainText('When');
  await expect(labels.nth(1)).toContainText('Pick-up');
  await expect(labels.nth(2)).toContainText('Travelers');
  await expect(labels.nth(3)).toContainText('Details');
  for (let i = 0; i < 4; i += 1) {
    await expect(labels.nth(i)).toBeVisible();
  }

  await page.goto('/plan.html?step=dates&stops=Colombo%20Airport%20(CMB)%7CKandy');
  const plannerLabels = page.locator('#journey .jlbl');
  await expect(plannerLabels).toHaveText(['Route', 'Dates', 'Service', 'Payment']);
  for (let i = 0; i < 4; i += 1) {
    await expect(plannerLabels.nth(i)).toBeVisible();
  }
});

test('mobile primary cards keep a visible edge gutter', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);

  const bookingCard = await page.locator('.stepcard.panel.active').boundingBox();
  const bookingSummary = await page.locator('#summary').boundingBox();
  expect(bookingCard).toBeTruthy();
  expect(bookingSummary).toBeTruthy();
  expect(bookingCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (bookingCard.x + bookingCard.width)).toBeGreaterThanOrEqual(18);
  expect(bookingSummary.x).toBeGreaterThanOrEqual(18);
  expect(390 - (bookingSummary.x + bookingSummary.width)).toBeGreaterThanOrEqual(18);

  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Colombo%20Airport%20(CMB)%7CKandy&pax=2&vehicle=car');

  const plannerCard = await page.locator('.setup-card').boundingBox();
  const legCard = await page.locator('#rail .leg-card').first().boundingBox();
  expect(plannerCard).toBeTruthy();
  expect(legCard).toBeTruthy();
  expect(plannerCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (plannerCard.x + plannerCard.width)).toBeGreaterThanOrEqual(18);
  expect(legCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (legCard.x + legCard.width)).toBeGreaterThanOrEqual(18);
});
