import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Chauffeur distance is billed in bulk (buffered travel km + idle-day min km) × per-km rate,
// with NO per-leg minimum fares — mirroring api/src/quote/chauffeur.ts. booking.js floored the
// charge at the PRIVATE per-leg total (Math.max(charge, tripBase)), which the backend engine
// doesn't: for a trip of short legs (where the $29 per-leg minimum dominates) the customer saw
// an inflated price that dropped at the pay step and tripped the ops price-mismatch flag.

// Two 20 km legs, car, two consecutive dates (idle-days = 0):
//   travelKm 40 → buffered round(44)=44 → distance charge round(44 × 0.35) = $15
//   day rate  $27 × 2 days = $54  →  total $69
// The buggy floor would instead use the private total (2 × $29 min = $58) → distance $58, total $112.
const TRIP = [
  'mode=trip',
  'stops=Colombo%20Airport%20(CMB)%7CKandy%7CElla',
  'nights=0,0,0',
  'dates=2026-08-10,2026-08-11',
  'kms=20,20',
  'pax=2',
  'vehicle=car',
  'start=2026-08-10',
].join('&');

test('chauffeur distance charge has no per-leg minimum floor (backend parity)', async ({ page }) => {
  await gotoBooking(page, { query: TRIP });
  await page.locator('[data-svc="chauffeur"]').click();

  // distance charge = the bulk km charge, NOT floored at the $58 private per-leg total
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  await expect(page.locator('#sum-adamt')).toHaveText('$15');
  await expect(page.locator('#sum-total')).toHaveText('$69');
});
