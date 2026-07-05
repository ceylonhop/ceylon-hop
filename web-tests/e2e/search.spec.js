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

test('search choices stay locked until Edit, then Update applies (Kayak/Expedia pattern)', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=cmb-airport&to=ella&pax=2' });

  // Locked by default: the edit form is collapsed, a read-only summary is shown.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();
  await expect(page.locator('#sl-route')).not.toBeEmpty();
  await expect(page.locator('#sl-meta')).toContainText('2 travelers');

  // Click Edit → the form reveals, pre-filled with the current search.
  await page.locator('#sl-edit').click();
  await expect(page.locator('#srch-bar')).toBeVisible();
  await expect(page.locator('#srch-locked')).toBeHidden();
  await expect(page.locator('#e-from')).toHaveValue('cmb-airport');
  await expect(page.locator('#e-to')).toHaveValue('ella');
  await expect(page.locator('#e-pax')).toHaveValue('2');

  // Cancel collapses back to the locked summary without changing anything.
  await page.locator('#sl-cancel').click();
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();

  // Edit again, change the drop-off, and Update → a deliberate new search navigation.
  await page.locator('#sl-edit').click();
  await page.locator('#e-to').selectOption('kandy');
  await page.locator('#srch-bar button[type="submit"]').click();
  await page.waitForURL('**/search.html?**to=kandy**');
  // The new search loads locked again.
  await expect(page.locator('#srch-bar')).toBeHidden();
  await expect(page.locator('#srch-locked')).toBeVisible();
});

test('a route with no shared service shows the "no shared seats" panel in the grid, beside the private card', async ({ page }) => {
  // Weligama -> Sigiriya has no daily shared corridor, so the shared slot shows the fallback panel.
  await gotoBooking(page, { path: '/search.html', query: 'from=weligama&to=sigiriya&pax=1' });

  await expect(page.getByText('No shared seats on this route')).toBeVisible();
  // It occupies the shared card's slot — a child of the two-up results grid, not a full-width block below it.
  await expect(page.locator('.opt-grid .noshare')).toBeVisible();
  // and the grid keeps its normal two-column layout (no single-column 'solo' fallback)
  await expect(page.locator('.opt-grid.solo')).toHaveCount(0);
});
