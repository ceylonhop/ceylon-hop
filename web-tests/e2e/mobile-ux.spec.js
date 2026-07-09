import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

test('mobile booking shows a compact context strip, not the full summary wall', async ({ page }) => {
  // Sticky-bar layout (spec 2026-07-09-mobile-booking-sticky-bar-design.md): the old
  // full summary card above every step is replaced by a slim strip + sticky total bar,
  // so the step content starts on the first screen.
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);
  await fillContact(page);

  const strip = await page.locator('#mstrip').boundingBox();
  const panel = await page.locator('.panel[data-panel="4"]').boundingBox();
  expect(strip).toBeTruthy();
  expect(panel).toBeTruthy();
  expect(strip.y).toBeLessThan(panel.y);
  expect(strip.height).toBeLessThanOrEqual(90);
  expect(panel.y).toBeLessThan(480); // step content reachable on the first screen
  await expect(page.locator('#mbar-amt')).not.toHaveText('—'); // sticky bar carries the total
  await expect(page.locator('#pay-due')).toBeVisible();
});

test('mobile terms consent has a reliable touch target and can be checked', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);
  await fillContact(page);

  const inputBox = await page.locator('#agree').boundingBox();
  const labelBox = await page.locator('label:has(#agree)').boundingBox();
  expect(inputBox).toBeTruthy();
  expect(labelBox).toBeTruthy();
  expect(inputBox.width).toBeGreaterThanOrEqual(22);
  expect(inputBox.height).toBeGreaterThanOrEqual(22);
  expect(labelBox.height).toBeGreaterThanOrEqual(48);

  await page.locator('#agree').uncheck();
  await page.locator('label:has(#agree)').click();
  await expect(page.locator('#agree')).toBeChecked();
});

test('mobile progress steps keep descriptive labels visible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);

  const labels = page.locator('#psteps .lbl');
  await expect(labels.nth(0)).toContainText('When');
  await expect(labels.nth(1)).toContainText('Pick-up');
  await expect(labels.nth(2)).toContainText('Travelers');
  await expect(labels.nth(3)).toContainText('Details');
  for (let i = 0; i < 4; i += 1) {
    await expect(labels.nth(i)).toBeVisible();
  }

  await page.goto('/plan.html?step=dates&stops=Colombo%20Airport%20(CMB)%7CKandy');
  const plannerLabels = page.locator('#journey .jlbl');
  await expect(plannerLabels).toHaveText(['Route', 'Dates', 'Service', 'Payment']);
  for (let i = 0; i < 4; i += 1) {
    await expect(plannerLabels.nth(i)).toBeVisible();
  }
});

test('mobile primary cards keep a visible edge gutter', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page);

  const bookingCard = await page.locator('.stepcard.panel.active').boundingBox();
  const bookingStrip = await page.locator('#mstrip').boundingBox();
  expect(bookingCard).toBeTruthy();
  expect(bookingStrip).toBeTruthy();
  expect(bookingCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (bookingCard.x + bookingCard.width)).toBeGreaterThanOrEqual(18);
  expect(bookingStrip.x).toBeGreaterThanOrEqual(18);
  expect(390 - (bookingStrip.x + bookingStrip.width)).toBeGreaterThanOrEqual(18);
  // the sticky bar is intentionally full-bleed
  const bar = await page.locator('#mbar').boundingBox();
  expect(bar).toBeTruthy();
  expect(bar.width).toBeGreaterThanOrEqual(388);

  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Colombo%20Airport%20(CMB)%7CKandy&pax=2&vehicle=car');

  const plannerCard = await page.locator('.setup-card').boundingBox();
  const legCard = await page.locator('#rail .leg-card').first().boundingBox();
  expect(plannerCard).toBeTruthy();
  expect(legCard).toBeTruthy();
  expect(plannerCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (plannerCard.x + plannerCard.width)).toBeGreaterThanOrEqual(18);
  expect(legCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (legCard.x + legCard.width)).toBeGreaterThanOrEqual(18);
});

test('mobile home hero and footer keep a visible edge gutter', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/index.html');

  const heroCopy = await page.locator('.hero-copy').boundingBox();
  const heroCard = await page.locator('.hero-card').boundingBox();
  expect(heroCopy).toBeTruthy();
  expect(heroCard).toBeTruthy();
  expect(heroCopy.x).toBeGreaterThanOrEqual(18);
  expect(heroCard.x).toBeGreaterThanOrEqual(18);
  expect(390 - (heroCard.x + heroCard.width)).toBeGreaterThanOrEqual(18);

  await page.locator('.footer').scrollIntoViewIfNeeded();
  const footerBrand = await page.locator('.foot-grid .brand').boundingBox();
  const footerExplore = await page.locator('.foot-grid h4', { hasText: 'Explore' }).boundingBox();
  const footerCopy = await page.locator('.foot-bottom span').first().boundingBox();
  expect(footerBrand).toBeTruthy();
  expect(footerExplore).toBeTruthy();
  expect(footerCopy).toBeTruthy();
  expect(footerBrand.x).toBeGreaterThanOrEqual(18);
  expect(footerExplore.x).toBeGreaterThanOrEqual(18);
  expect(footerCopy.x).toBeGreaterThanOrEqual(18);
});

test('mobile exact location map stays compact and readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, {
    query: 'mode=private&from=cmb-airport&to=sigiriya&price=77&vehicle=car',
    routeKm: 145,
  });
  await page.evaluate(() => window.goStep && window.goStep(2));
  await expect(page.locator('#route-map')).toBeVisible();

  const mapBox = await page.locator('#route-map .ch-map-wrap, #route-map .rm-canvas svg').first().boundingBox();
  const barBox = await page.locator('#rm-bar').boundingBox();
  const noteBox = await page.locator('#pvt-note').boundingBox();
  const navBox = await page.locator('#nav1').boundingBox();
  expect(mapBox).toBeTruthy();
  expect(barBox).toBeTruthy();
  expect(noteBox).toBeTruthy();
  expect(navBox).toBeTruthy();
  expect(mapBox.height).toBeLessThanOrEqual(190);
  expect(barBox.height).toBeGreaterThanOrEqual(48);
  expect(noteBox.y).toBeGreaterThan(barBox.y);
  expect(navBox.y).toBeGreaterThan(noteBox.y);
  await expect(page.locator('#rm-bar')).toContainText('145 km');
});
