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

test('the expand button opens a modal map and closes cleanly', async ({ page }) => {
  await gotoPlanner(page);

  const btn = page.locator('#trip-map .ch-map-expand');
  await expect(btn).toBeVisible();
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);

  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await expect(page.locator('.ch-map-modal-map .ch-map-wrap')).toBeVisible();

  // Esc closes and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
  await expect(btn).toBeFocused();

  // Backdrop click closes.
  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await page.locator('.ch-map-modal').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);

  // Close button closes.
  await btn.click();
  await page.locator('.ch-map-close').click();
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
});

test('the modal map is freely manipulable and reuses the computed route', async ({ page }) => {
  await gotoPlanner(page);
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  const before = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  await page.locator('#trip-map .ch-map-expand').click();
  await expect(page.locator('.ch-map-modal-map .ch-map-wrap')).toBeVisible();

  // Inline card stays 'cooperative' so it never hijacks page scroll; the modal is 'greedy'.
  const gestures = await page.evaluate(() => (window.__chMaps || []).map((m) => m.gestureHandling));
  expect(gestures[0]).toBe('cooperative');
  expect(gestures[gestures.length - 1]).toBe('greedy');

  // The memo means opening the modal costs no extra Routes call.
  const after = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  expect(after).toBe(before);
});

test('no expand button on the SVG island fallback', async ({ page }) => {
  // No stubs installed => ch-map's loader fails => renderRoute falls back to the SVG.
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  await expect(page.locator('#trip-map svg')).toBeVisible();
  await expect(page.locator('.ch-map-expand')).toHaveCount(0);
});
