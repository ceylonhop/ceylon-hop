import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Owner 2026-10-16: a shared seat can add a hotel pick-up and a hotel drop-off per BOOKING (hotel
// near the meeting point; ops confirms). Owner 2026-10-29: two add-ons, $5 each, hotel within
// 5 km. They ride the booking page's add-on buttons, priced from the generated EXTRAS table, and
// are offered on shared seats only.
const SHARED_QUERY =
  'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';
const pickup = (page) => page.locator('.addon[data-addon="hotel-pickup"]');
const dropoff = (page) => page.locator('.addon[data-addon="hotel-dropoff"]');
const sightseeing = (page) => page.locator('.addon[data-addon="sightseeing"]');

test('a shared seat offers a hotel pick-up and a hotel drop-off at +$5 each, and not sightseeing', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });
  await page.evaluate(() => window.goStep(3));
  for (const addon of [pickup(page), dropoff(page)]) {
    await expect(addon).toBeVisible();
    await expect(addon).toContainText('within 5 km');
    await expect(addon.locator('.pr')).toHaveText('+$5');
  }
  await expect(sightseeing(page)).toBeHidden();
});

test('each adds $5 once, whatever the seat count, and both add $10', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY.replace('pax=1', 'pax=2') });
  await page.evaluate(() => window.goStep(3));
  await expect(page.locator('#sum-total')).toHaveText('$38');
  await pickup(page).click();
  await expect(pickup(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sum-total')).toHaveText('$43');
  await expect(page.locator('.s-row', { hasText: 'Hotel pick-up' })).toContainText('$5');
  await dropoff(page).click();
  await expect(page.locator('#sum-total')).toHaveText('$48');
  await expect(page.locator('.s-row', { hasText: 'Hotel drop-off' })).toContainText('$5');
  await pickup(page).click();
  await expect(page.locator('#sum-total')).toHaveText('$43');
  await dropoff(page).click();
  await expect(page.locator('#sum-total')).toHaveText('$38');
});

test('a private transfer offers neither', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(3));
  await expect(sightseeing(page)).toBeVisible();
  await expect(pickup(page)).toBeHidden();
  await expect(dropoff(page)).toBeHidden();
});
