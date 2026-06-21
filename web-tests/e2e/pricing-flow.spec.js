import { test, expect } from '@playwright/test';
import { gotoBooking, pickPlace } from './_stubs.js';

test('price holds at the quoted amount on load (no re-price from the pre-filled route)', async ({ page }) => {
  // Stubbed route reports 200km, but an unchanged pre-filled route must NOT re-price.
  await gotoBooking(page, { routeKm: 200 });
  await expect(page.locator('#sum-total')).toHaveText('$121');
  // give the map/onRoute a moment — price must still hold (regression: b528abc)
  await page.waitForTimeout(1200);
  await expect(page.locator('#sum-total')).toHaveText('$121');
});

test('re-prices from real distance after the customer picks a new drop-off', async ({ page }) => {
  await gotoBooking(page, { routeKm: 200 }); // legPrice(200,'car') = $146
  await expect(page.locator('#sum-total')).toHaveText('$121');

  await pickPlace(page, '#loc-to', 'ac-to', 'Jaffna');

  await expect(page.locator('#sum-total')).toHaveText('$146');
  await expect(page.locator('#sum-name')).toContainText('Jaffna Result 1');
});
