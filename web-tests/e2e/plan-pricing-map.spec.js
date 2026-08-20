import { test, expect } from '@playwright/test';
import { blockLiveApi, gotoBooking } from './_stubs.js';

// index.html/tours.html/pay.html ping the live API on load (0e0f077) — keep the suite offline.
test.beforeEach(async ({ page }) => { await blockLiveApi(page); });

// Resolve a design token to the rgb() string the browser reports, so these assertions
// track site.css instead of a frozen hex. They pinned rgb(44,42,43) — the pre-brand-book
// ink — and broke when --ink moved to the book's Bristol Black. The INTENT is "unselected
// options use the full ink, not a muted grey", which is a token relationship, not a hex.
const tokenColor = (page, name) => page.evaluate((n) => {
  const raw = getComputedStyle(document.documentElement).getPropertyValue(n).trim();
  const probe = document.createElement('div');
  probe.style.color = raw;
  document.body.appendChild(probe);
  const rgb = getComputedStyle(probe).color;
  probe.remove();
  return rgb;
}, name);

test('planner prices Kandy to Ella with the shared route table', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  await expect(page.locator('#rail .leg-card')).toHaveCount(1);
  const legMeta = page.locator('#rail [data-dist]');
  await expect(legMeta).toContainText('Approx. 135 km · 3h 45m');
  await expect(legMeta).toContainText('Reviewed route');
  await expect(legMeta).toContainText('from $59');
  await expect(legMeta.locator('.lm-src')).toHaveText('Reviewed route');
  await expect(legMeta.locator('.lm-src + .lm-sep + .lm-price')).toContainText('from $59');
  await expect(legMeta.locator('.lm-price .lm-veh')).toHaveAttribute('aria-label', 'Private AC car');
  await expect(page.locator('#st-drive')).toHaveText('Approx. 135 km · 3h 45m');
  await expect(page.locator('#sum-amt')).toHaveText(/\$55[-\u2013]\$70/);
});

test('planner vehicle switch updates prices without rebuilding the route map', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  const mapSvg = page.locator('#trip-map svg').first();
  await expect(mapSvg).toBeVisible();
  await mapSvg.evaluate((el) => { el.dataset.e2eMapNode = 'stable'; });

  await expect(page.locator('#rail [data-dist]')).toContainText('from $59');
  await expect(page.locator('#rail [data-dist] .lm-price .lm-veh')).toHaveAttribute('aria-label', 'Private AC car');
  await expect(page.locator('#sum-amt')).toHaveText(/\$55[-\u2013]\$70/);

  await page.locator('.veh-btn[data-veh="van"]').click();

  await expect(page.locator('#rail [data-dist]')).toContainText('from $81');
  await expect(page.locator('#rail [data-dist] .lm-price .lm-veh')).toHaveAttribute('aria-label', 'Private AC van');
  await expect(page.locator('#sum-amt')).toHaveText(/\$80[-\u2013]\$95/); // guide range = ceil(finished+10) & a $25/$15 band
  await expect(page.locator('#trip-map svg[data-e2e-map-node="stable"]')).toHaveCount(1);
});

test('mobile planner keeps unselected vehicle option text readable', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  const ink = await tokenColor(page, '--ink');
  const selected = await tokenColor(page, '--accent-deep');

  await expect(page.locator('.veh-btn[data-veh="van"] b')).toHaveCSS('color', ink);
  await expect(page.locator('.veh-btn[data-veh="van"] b')).toHaveCSS('-webkit-text-fill-color', ink);
  await expect(page.locator('.veh-btn[data-veh="car"] b')).toHaveCSS('color', selected);
  await expect(page.locator('.veh-btn[data-veh="car"] b')).toHaveCSS('-webkit-text-fill-color', selected);

  await page.locator('.veh-btn[data-veh="van"]').click();
  await expect(page.locator('.veh-btn[data-veh="car"] b')).toHaveCSS('color', ink);
  await expect(page.locator('.veh-btn[data-veh="car"] b')).toHaveCSS('-webkit-text-fill-color', ink);
  await expect(page.locator('.veh-btn[data-veh="van"] b')).toHaveCSS('color', selected);
  await expect(page.locator('.veh-btn[data-veh="van"] b')).toHaveCSS('-webkit-text-fill-color', selected);
});

test('mobile planner keeps the longer shared route estimate readable', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  const meta = page.locator('#rail [data-dist]');
  await expect(meta).toContainText('Approx. 135 km · 3h 45m');
  await expect(meta.locator('.lm-src')).toBeHidden();
  await expect(meta.locator('.lm-sep')).toBeHidden();
  expect(await meta.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);

  const drive = page.locator('#st-drive');
  await expect(drive).toHaveText('Approx. 135 km · 3h 45m');
  expect(await drive.evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
});

test('planner prices country-suffixed popular places without waiting for Google', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kalpitiya%2C%20Sri%20Lanka%7CJaffna%7CTrincomalee&pax=2&vehicle=car');

  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  const firstLegDistance = page.locator('#rail .leg-card').first().locator('[data-dist]');
  await expect(firstLegDistance).toContainText('km');
  await expect(firstLegDistance).toContainText('from $');
  await expect(firstLegDistance).not.toContainText('Pick both points');
  await expect(page.locator('#st-drive')).toContainText('km');
});

test('planner guide range never rounds a priced car transfer down to zero', async ({ page }) => {
  await gotoBooking(page, {
    path: '/plan.html',
    query: 'stops=Yatiyanthota%2C%20Sri%20Lanka%7CRatnapura%2C%20Sri%20Lanka&pax=2&vehicle=car',
    routeKm: 52,
  });

  await expect(page.locator('#rail [data-dist]')).toContainText('Approx. 50 km · 1h 15m');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $29');
  await expect(page.locator('#sum-amt')).toHaveText(/\$29[-\u2013]\$40/);
  await expect(page.locator('#sum-amt')).not.toContainText('$0');
});

test('planner passes Google-measured leg distance into booking handoff', async ({ page }) => {
  await gotoBooking(page, {
    path: '/plan.html',
    query: 'stops=Yatiyanthota%2C%20Sri%20Lanka%7CRatnapura%2C%20Sri%20Lanka&pax=2&vehicle=car',
    routeKm: 52,
  });

  await expect(page.locator('#rail [data-dist]')).toContainText('Approx. 50 km · 1h 15m');
  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  const url = new URL(page.url());
  expect(url.searchParams.get('kms')).toBe('52');
});

test('search add-stops handoff preserves the equivalent base route price', async ({ page }) => {
  await gotoBooking(page, { path: '/search.html', query: 'from=kandy&to=ella&pax=2' });

  await expect(page.locator('a[href*="price=59"][href*="rawPrice=60"][href*="vehicle=car"]').first()).toBeVisible();
  await page.locator('#add-stops').click();
  await page.waitForURL('**/plan.html?**');

  await expect(page.locator('#rail [data-dist]')).toContainText('Approx. 135 km · 3h 45m');
  await expect(page.locator('#rail [data-dist]')).toContainText('from $59');
  await expect(page.locator('#sum-amt')).toHaveText(/\$55[-\u2013]\$70/);
});

test('planner fallback map keeps repeated stops in the visible route order', async ({ page }) => {
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla%7CKandy&pax=2&vehicle=car');

  const map = page.locator('#trip-map');
  await expect(map.locator('.tm-pin-num')).toHaveCount(3);
  await expect(map.locator('.tm-pin-num').nth(0)).toHaveText('1');
  await expect(map.locator('.tm-pin-num').nth(1)).toHaveText('2');
  await expect(map.locator('.tm-pin-num').nth(2)).toHaveText('3');
  await expect(map.locator('.tm-pin-label', { hasText: 'Kandy' })).toHaveCount(2);
});

test('discontinuous route keeps leg distances aligned per stop-pair in the booking handoff', async ({ page }) => {
  // Regression: goToBooking used to emit one km per raw transfer leg while stops/dates come
  // from the merged per-wire sequence. Editing leg 2's pick-up to a different place inserts a
  // "phantom" wire (Ella→Galle) that no leg covers, which shifted every later km onto the wrong
  // stop-pair. kms must now be index-aligned with stops: one entry per wire, phantom wire empty.
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla%7CMirissa&pax=2&vehicle=car');

  await expect(page.locator('#rail .leg-card')).toHaveCount(2);
  // Break continuity: leg 2 becomes Galle→Mirissa (was Ella→Mirissa).
  const leg2From = page.locator('#rail .leg-card').nth(1).locator('.leg-from');
  await leg2From.click();
  await leg2From.fill('Galle');
  await expect(page.locator('.place-menu')).toBeVisible();
  await page.locator('.place-option', { hasText: 'Galle' }).first().click();

  await page.locator('#request-btn').click();
  await page.locator('#dates-continue').click();
  await page.waitForURL('**/booking.html?**');

  const q = new URL(page.url()).searchParams;
  const stops = q.get('stops').split('|');
  const kms = q.get('kms').split(',');
  expect(stops).toEqual(['Kandy', 'Ella', 'Galle', 'Mirissa']);
  // one km per wire (stops-1); the real legs keep their own distances, the phantom wire is blank
  expect(kms).toHaveLength(stops.length - 1);
  expect(kms[0]).toBe('136');   // Kandy→Ella
  expect(kms[1]).toBe('');      // Ella→Galle phantom wire (no leg) — NOT another leg's km
  expect(kms[2]).toBe('41');    // Galle→Mirissa
});

test('a trip leg with no resolvable distance is charged the estimate, not $0', async ({ page }) => {
  // Regression: tripQuoteWithKms priced an unresolvable leg at $0 (baked tripQuote charges a
  // $55 estimate), silently dropping a whole leg from the quoted+charged total. Leg 1 Kandy→Ella
  // prices from km 136 ($60); leg 2 Ella→Zzznowhere resolves no distance and must add $55 → $115.
  await gotoBooking(page, {
    query: 'mode=trip&stops=Kandy%7CElla%7CZzznowhere&nights=0,0,0&dates=,&kms=136,&pax=2&vehicle=car',
  });

  await expect(page.locator('#sum-total')).toContainText('115');
  await expect(page.locator('#sum-total')).not.toHaveText(/\$60\b/);
});
