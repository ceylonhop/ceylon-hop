import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

const TRIP_QUERY = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,1,0',
  'dates=2026-08-08,2026-08-10',
  'pax=2',
  'vehicle=car',
].join('&');

test('trip service labels distinguish per-leg private pricing from chauffeur pricing', async ({ page }) => {
  await gotoBooking(page, { query: TRIP_QUERY });

  await expect(page.locator('#svc-chooser')).toBeVisible();
  await expect(page.locator('#svc-private-tag')).toHaveText('Priced per leg · pay in full');
  await expect(page.locator('#svc-chauffeur-tag')).toContainText('Day rate + trip distance');
  await expect(page.locator('#svc-chauffeur-tag')).toContainText('pay in full');

  await expect(page.locator('#trip-route .tr-leg')).toHaveCount(2);
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Leg 1');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Kandy');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Sat 8 Aug');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('km');

  await expect(page.locator('#pvt-note-tx')).toContainText('Each leg is priced as its own private transfer');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#pvt-note-tx')).toContainText('Priced as a retained driver-guide: daily rate plus total trip distance.');
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  await expect(page.locator('#sum-adamt')).not.toHaveText('$0');
});

test('chauffeur service is unavailable until every trip leg has a date', async ({ page }) => {
  const query = [
    'mode=trip',
    'stops=Negombo%7CSigiriya%7CKandy%7CElla',
    'nights=0,0,0,0',
    'dates=2026-08-08,,',
    'pax=4',
    'vehicle=van',
  ].join('&');

  await gotoBooking(page, { query });

  const chauffeur = page.locator('[data-svc="chauffeur"]');
  await expect(chauffeur).toBeDisabled();
  await expect(page.locator('#svc-chauffeur-tag')).toHaveText('Add all dates to quote');
  await expect(page.locator('#chauffeur-extra')).toContainText('Add all leg dates to quote chauffeur-guide');
  await expect(page.locator('#chauffeur-extra')).toContainText('every transfer leg has a date');

  await chauffeur.click({ force: true });

  await expect(chauffeur).not.toHaveClass(/on/);
  await expect(page.locator('[data-svc="private"]')).toHaveClass(/on/);
  await expect(page.locator('#sum-adlabel')).toHaveText(/Private AC van · per leg/);
  await expect(page.locator('#sum-adlabel')).not.toHaveText(/Chauffeur distance/);
});

test('trip booking review shows planner-provided Google distances for exact-place legs', async ({ page }) => {
  const query = [
    'mode=trip',
    'stops=Yatiyanthota%2C%20Sri%20Lanka%7CRatnapura%2C%20Sri%20Lanka%7CKankesanturai',
    'nights=0,0,0',
    'dates=2026-07-10,2026-07-11',
    'kms=52,236',
    'pax=2',
    'vehicle=car',
  ].join('&');

  await gotoBooking(page, { query });

  await expect(page.locator('#trip-route .tr-leg')).toHaveCount(2);
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('52 km');
  await expect(page.locator('#trip-route .tr-leg').nth(1)).toContainText('236 km');
  await expect(page.locator('#trip-route')).not.toContainText('Distance on request');
  await expect(page.locator('#sum-total')).toHaveText('$120');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  // bulk km charge (round(round(288×1.1)×0.35)=$111), NOT floored at the $120 private per-leg total
  await expect(page.locator('#sum-adamt')).toHaveText('$111');
  await expect(page.locator('#sum-total')).toHaveText('$181');
});

test('fallback-priced trip does not show zero chauffeur distance', async ({ page }) => {
  const query = [
    'mode=trip',
    'stops=Yatiyanthota%2C%20Sri%20Lanka%7CRatnapura%2C%20Sri%20Lanka%7CKankesanturai',
    'nights=0,0,0',
    'dates=2026-07-10,2026-07-11',
    'price=110',
    'pax=2',
    'vehicle=car',
  ].join('&');

  await gotoBooking(page, { query });
  await expect(page.locator('#sum-total')).toHaveText('$110');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#trip-route')).toContainText('Distance on request');
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  await expect(page.locator('#sum-adamt')).toHaveText('$110');
  await expect(page.locator('#sum-total')).toHaveText('$180');
});
