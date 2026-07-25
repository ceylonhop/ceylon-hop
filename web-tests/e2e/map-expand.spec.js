import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// gotoBooking installs the Google/PayHere stubs and mocks the API; `path` retargets it at
// any page. With the stubs present, ch-map's loadJs() short-circuits and the REAL Google
// map path runs (no stubs => the SVG island fallback runs instead).
const gotoPlanner = (page) => gotoBooking(page, {
  path: '/plan.html',
  query: 'stops=Kandy%7CElla&pax=2&vehicle=car',
});

test('map pins are numbered so they can be matched to stops', async ({ page }) => {
  await gotoPlanner(page);
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  const labels = await page.evaluate(() =>
    (window.__chMarkers || []).map((m) => m.label && m.label.text));
  expect(labels).toEqual(['1', '2']);
});
