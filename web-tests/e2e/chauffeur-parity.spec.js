import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Chauffeur distance is billed from the sum of buffered travel legs plus idle-day min km × per-km rate,
// with NO per-leg minimum fares — mirroring api/src/quote/chauffeur.ts. booking.js floored the
// charge at the PRIVATE per-leg total (Math.max(charge, tripBase)), which the backend engine
// doesn't: for a trip of short legs (where the $29 per-leg minimum dominates) the customer saw
// an inflated price that dropped at the pay step and tripped the ops price-mismatch flag.

// Two 20 km legs, car, two consecutive dates (idle-days = 0):
//   buffered travel = 25 + 25 = 50 → distance charge round(50 × 40.25¢) = $20.13
//   day rate  $31.05 × 2 days = $62.10  → raw total $82.23 → finished $82
// The buggy floor would instead use the private total (2 × $29 min = $58) → distance $58, total $120.10.
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

  // distance charge = the bulk km charge, NOT floored at the $58 private per-leg total ($20.13 raw).
  // The distance row absorbs the finishing adjustment so the rows sum to Total:
  // day-rate $62.10 + distance $19.90 = $82.
  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  await expect(page.locator('#sum-adamt')).toHaveText('$19.90');
  await expect(page.locator('#sum-total')).toHaveText('$82');
});

// Same trip but the second leg is two days later (idle-days = 1). A car idle day bills the
// CAR minimum of 50 km/day (vans stay at 100) — mirrors RATE_CARD.chauffeur.idleMinKm:
//   buffered travel 25 + 25 = 50, + 1 idle × 50 = 100 km → distance round(100 × 40.25¢) = $40.25
//   day rate $31.05 × 3 days = $93.15 → raw total $133.40 → finished $133.50 (nearest 50¢;
//   the distance row absorbs the +$0.10 adjustment → $40.35).
const TRIP_IDLE = TRIP.replace('dates=2026-08-10,2026-08-11', 'dates=2026-08-10,2026-08-12');

test('car idle day bills the 50 km car minimum, not the 100 km van minimum', async ({ page }) => {
  await gotoBooking(page, { query: TRIP_IDLE });
  await page.locator('[data-svc="chauffeur"]').click();

  await expect(page.locator('#sum-adlabel')).toHaveText(/Chauffeur distance/);
  await expect(page.locator('#sum-adamt')).toHaveText('$40.35');
  await expect(page.locator('#sum-total')).toHaveText('$133.50');
});
