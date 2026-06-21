import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

test('clicking Pay opens the payment overlay immediately', async ({ page }) => {
  await gotoBooking(page);
  await fillContact(page);
  await page.click('#pay-btn');
  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-spin')).toBeVisible();
});

test('a booking-API failure shows an error state inside the overlay (not a stray note)', async ({ page }) => {
  await gotoBooking(page, { bookingStatus: 500 });
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-ico')).toBeVisible();
  await expect(page.locator('#ph-actions')).toBeVisible();
  await expect(page.locator('#ph-retry')).toBeVisible();
  await expect(page.locator('#ph-msg')).toContainText('couldn’t start your booking');
  // the inline form error must NOT be used for payment outcomes
  await expect(page.locator('#details-error')).toBeHidden();
});

test('cancelling PayHere shows the cancelled state with a retry option', async ({ page }) => {
  await gotoBooking(page, { checkout: 'payhere', payhere: 'dismissed' });
  await fillContact(page);
  await page.click('#pay-btn');

  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect(page.locator('#ph-msg')).toContainText('cancelled');
  await expect(page.locator('#ph-retry')).toBeVisible();

  // Close dismisses the overlay
  await page.click('#ph-close');
  await expect(page.locator('#ph-overlay')).toBeHidden();
});

test('demo mode (api=off) completes to a confirmation reference', async ({ page }) => {
  await gotoBooking(page, { query: 'mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car&api=off' });
  await fillContact(page);
  await page.click('#pay-btn');
  await expect(page.locator('#ph-overlay')).toBeVisible();
  await expect.poll(
    () => page.locator('#pass-ref').textContent(),
    { timeout: 8000 },
  ).toMatch(/CH-/);
});
