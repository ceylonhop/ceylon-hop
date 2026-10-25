import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Owner 2026-10-16: a shared seat can add hotel pick-up & drop-off for $5 per BOOKING (hotel within
// 2 km of the meeting points; ops confirms). It rides the booking page's add-on buttons, priced from
// the generated EXTRAS table, and is offered on shared seats only.
const SHARED_QUERY =
  'mode=shared&from=cmb-airport&to=kandy&price=19&times=07:30&corridor=airport-cultural&days=3,6&pax=1';
const hotel = (page) => page.locator('.addon[data-addon="hotel-transfer"]');
const sightseeing = (page) => page.locator('.addon[data-addon="sightseeing"]');

test('a shared seat offers hotel pick-up & drop-off at +$5, and not sightseeing', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY });
  await page.evaluate(() => window.goStep(3));
  await expect(hotel(page)).toBeVisible();
  await expect(hotel(page)).toContainText('within 2 km');
  await expect(hotel(page).locator('.pr')).toHaveText('+$5');
  await expect(sightseeing(page)).toBeHidden();
});

test('ticking it adds $5 once, whatever the seat count', async ({ page }) => {
  await gotoBooking(page, { query: SHARED_QUERY.replace('pax=1', 'pax=2') });
  await page.evaluate(() => window.goStep(3));
  await expect(page.locator('#sum-total')).toHaveText('$38');
  await hotel(page).click();
  await expect(hotel(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('#sum-total')).toHaveText('$43');
  await expect(page.locator('.s-row', { hasText: 'Hotel pick-up & drop-off' })).toContainText('$5');
  await hotel(page).click();
  await expect(page.locator('#sum-total')).toHaveText('$38');
});

test('a private transfer does not offer it', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep(3));
  await expect(sightseeing(page)).toBeVisible();
  await expect(hotel(page)).toBeHidden();
});
