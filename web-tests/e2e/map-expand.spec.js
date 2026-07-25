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

test('closing after the opening button was replaced (inline re-render) does not drop focus to <body>', async ({ page }) => {
  await gotoPlanner(page);

  const btn = page.locator('#trip-map .ch-map-expand');
  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();

  // Simulate plan.js re-rendering the inline map while the modal is open (see the comment
  // above openExpanded in ch-map.js): the button that opened the modal is destroyed and a
  // fresh one takes its place, so the modal's saved prevFocus reference goes stale/detached.
  await page.evaluate(() => {
    const host = document.getElementById('trip-map');
    const oldBtn = host.querySelector('.ch-map-expand');
    const freshBtn = oldBtn.cloneNode(true);
    oldBtn.replaceWith(freshBtn);
  });

  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);

  // Focus must land somewhere sensible, not get dropped to <body>.
  const active = await page.evaluate(() => document.activeElement.tagName);
  expect(active).not.toBe('BODY');
  await expect(page.locator('#trip-map .ch-map-expand')).toBeFocused();
});

test('no expand button on the SVG island fallback', async ({ page }) => {
  // No stubs installed => ch-map's loader fails => renderRoute falls back to the SVG.
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  await expect(page.locator('#trip-map svg')).toBeVisible();
  await expect(page.locator('.ch-map-expand')).toHaveCount(0);
});

test('the modal lists the stops, numbered and colour-matched to the pins', async ({ page }) => {
  await gotoBooking(page, { path: '/plan.html', query: 'stops=Kandy%7CElla%7CGalle&pax=2&vehicle=car' });
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  await page.locator('#trip-map .ch-map-expand').click();
  const items = page.locator('.ch-map-legend li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Kandy');
  await expect(items.nth(1)).toContainText('Ella');
  await expect(items.nth(2)).toContainText('Galle');
  await expect(items.nth(0).locator('.ch-lg-n')).toHaveText('1');
  await expect(items.nth(2).locator('.ch-lg-n')).toHaveText('3');

  // Pick-up green, final drop-off orange — matching the pin colours.
  await expect(items.nth(0).locator('.ch-lg-n')).toHaveCSS('background-color', 'rgb(10, 125, 111)');
  await expect(items.nth(2).locator('.ch-lg-n')).toHaveCSS('background-color', 'rgb(232, 98, 58)');
});

test('the booking transfer map is expandable too', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep && window.goStep(2));

  const btn = page.locator('#rm-canvas .ch-map-expand');
  await expect(btn).toBeVisible();

  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await expect(page.locator('.ch-map-legend li')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
});
