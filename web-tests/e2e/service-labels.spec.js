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
  await expect(page.locator('#svc-chauffeur-tag')).toContainText('deposit');

  await expect(page.locator('#pvt-note-tx')).toContainText('Each leg is priced as its own private transfer');

  await page.locator('[data-svc="chauffeur"]').click();
  await expect(page.locator('#pvt-note-tx')).toContainText('Priced as a retained driver-guide: daily rate plus total trip distance.');
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
});
