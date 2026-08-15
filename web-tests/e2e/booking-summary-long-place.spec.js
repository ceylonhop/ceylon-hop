import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// Owner-reported 2026-08-15 (screenshot): the right-hand summary printed the customer's FULL
// Google address. A Google-picked pick-up reaches booking.html as its whole formatted address —
// the planner passes the picked string straight through as ?from=, `TRANSFERS.place()` doesn't
// know it, so the raw param becomes the stop name (booking.js's route construction). The teal
// route box wrapped that to five lines and the serif <h3> under it to five more, pushing Date /
// Departure / Luggage off the fold.
//
// ch-shortplace.js is the shortener ops, the pay page, the emails and plan.js already share; the
// booking page was simply never given it. Display only — state.locFrom/locTo keep the full string,
// so pricing, geocoding, the out-of-area guard and the submitted booking are untouched.
const AIRPORT = 'Colombo Bandaranaike International Airport (CMB), Airport and Aviation Services (Sri Lanka) (Private) Limited, Canada Friendship Rd, Katunayake, Sri Lanka';
const AIRPORT_SHORT = 'Colombo Bandaranaike International Airport (CMB) · Katunayake';

test('the summary shortens a full Google address instead of printing every segment', async ({ page }) => {
  await gotoBooking(page, {
    query: `mode=private&from=${encodeURIComponent(AIRPORT)}&to=Pasikudah&price=121&vehicle=car`,
  });

  await expect(page.locator('#sum-from')).toHaveText(AIRPORT_SHORT);
  await expect(page.locator('#sum-to')).toHaveText('Pasikudah');
  await expect(page.locator('#sum-name')).toHaveText(`Private transfer · ${AIRPORT_SHORT} → Pasikudah`);

  // The middle segments are what blew the panel up. They must be GONE, not merely wrapped —
  // a line-clamp alone would still leave them in the DOM and in the accessible name.
  await expect(page.locator('#sum-from')).not.toContainText('Canada Friendship Rd');
  await expect(page.locator('#sum-name')).not.toContainText('Airport and Aviation Services');
});

test('a place the shortener cannot split is still passed through whole', async ({ page }) => {
  // One segment, no comma: there is nothing to drop, so the label must survive untouched rather
  // than being truncated into something the customer cannot recognise as their own pick-up.
  await gotoBooking(page, { query: 'mode=private&from=Negombo&to=Pasikudah&price=121&vehicle=car' });

  await expect(page.locator('#sum-from')).toHaveText('Negombo');
  await expect(page.locator('#sum-to')).toHaveText('Pasikudah');
});
