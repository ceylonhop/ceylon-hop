import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

test('search prices on real distance and carries that price into booking', async ({ page }) => {
  // reuse the stub harness (installs Maps/PayHere stubs + API mocks for the booking nav)
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // CMB -> Ella private car on real distance (335km):
  // billableKm = round(335×1.10) = 369; max(29, round(369×0.46)) = $170
  const selectLink = page.locator('a[href*="price=170"][href*="vehicle=car"]').first();
  await expect(selectLink).toBeVisible();
  await expect(page.getByText('$170').first()).toBeVisible();

  await selectLink.click();
  await page.waitForURL('**/booking.html**');
  // booking holds the quoted price on load
  await expect(page.locator('#sum-total')).toHaveText('$170');
});
