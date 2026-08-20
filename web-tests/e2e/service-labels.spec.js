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
  // No surface prices the driver by the day any more (owner decision 2026-08-14) — the chip sells
  // the shape of the service, not its rate card.
  await expect(page.locator('#svc-chauffeur-tag')).toContainText('Priced for the whole trip');
  await expect(page.locator('#svc-chauffeur-tag')).toContainText('pay in full');
  await expect(page.locator('#svc-chauffeur-tag')).not.toContainText('Day rate');

  await expect(page.locator('#trip-route .tr-leg')).toHaveCount(2);
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Leg 1');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Colombo Airport (CMB)');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Kandy');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('Sat 8 Aug');
  await expect(page.locator('#trip-route .tr-leg').first()).toContainText('km');

  await expect(page.locator('#pvt-note-tx')).toContainText('Each leg is priced as its own private transfer');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#pvt-note-tx')).toContainText('One price covers the car, your driver-guide and every kilometre.');
  await expect(page.locator('#pvt-note-tx')).not.toContainText('daily rate');
  // Car + driver-guide bill as one whole-trip line — no separate day-rate row to price the driver
  // out in the open (owner decision 2026-08-14). The service chooser stays the visible difference.
  await expect(page.locator('#sum-adlabel')).toHaveText('Private AC car · whole trip');
  await expect(page.locator('#sum-adamt')).not.toHaveText('$0');
  await expect(page.locator('#sum-addons')).not.toContainText('Chauffeur-guide');
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
  await expect(page.locator('#sum-adlabel')).toHaveText(/Private AC van · whole trip/);
  await expect(page.locator('#sum-addons')).not.toContainText('Chauffeur-guide');
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
  await expect(page.locator('#sum-total')).toHaveText('$130');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#sum-adlabel')).toHaveText('Private AC car · whole trip');
  // Chauffeur = day rate + one trip-distance charge. Raw distance is (57 km + 251 km) × $0.4025 =
  // $123.97 (buffers clamped, no private-transfer minimum fares), plus day-rate $62.10 → $186.07
  // raw. Both ride on the one whole-trip row, which absorbs the −$0.07 finishing → $186 = Total.
  await expect(page.locator('#sum-adamt')).toHaveText('$186');
  await expect(page.locator('#sum-total')).toHaveText('$186'); // $186.07 raw → finished $186
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
  await expect(page.locator('#sum-adlabel')).toHaveText('Private AC car · whole trip');
  // The whole-trip row absorbs the finishing adjustment so it equals Total: raw distance $110 +
  // day-rate $62.10 = $172.10 raw, finished to $172 — $149 is far out of reach from $172.10, so
  // threshold finishing just drops the cents (2026-08-19).
  await expect(page.locator('#sum-adamt')).toHaveText('$172');
  await expect(page.locator('#sum-total')).toHaveText('$172');
});
