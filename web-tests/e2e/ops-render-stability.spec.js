import { test, expect } from '@playwright/test';

// Render stability: committing a change in the ops quote builder must NOT rebuild DOM that
// didn't change. The old render() replaced the panel wholesale (innerHTML =), which repainted
// every component, re-parented the route map, and read as "everything flickers/reloads on
// every edit" (owner video, 2026-07-21). render() now DIFFS the new tree against the live DOM
// (vendored morphdom), so untouched nodes keep their identity by construction.
//
// The test pins that contract: tag live nodes with a JS property (a property survives only if
// the NODE survives — innerHTML rebuilds lose it), commit an unrelated change, assert the tags
// are still there.
//
// Same offline stubbed harness as ops-quote-route-choice.spec.js (no DB, no Google key).

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page, { mapKey } = {}) {
  // Full async-Maps stub (mirrors ops-itin-map.spec.js) so the itinerary map section
  // renders when a key is forced via window.OPS_MAPS_KEY.
  await page.addInitScript((k) => {
    if (k) window.OPS_MAPS_KEY = k;
    function Map(el) { this.__el = el; if (el) el.setAttribute('data-map', 'ready'); }
    Map.prototype.fitBounds = function () {};
    function Marker() {}
    Marker.prototype.setMap = function () {};
    function Point() {}
    function Polyline() {}
    Polyline.prototype.setOptions = function () {};
    Polyline.prototype.setMap = function () {};
    const Route = {
      computeRoutes: async () => ({
        routes: [{
          path: [],
          viewport: {},
          legs: [{ startLocation: { lat: 6.93, lng: 79.85 }, endLocation: { lat: 7.29, lng: 80.63 } }],
          createPolylines: () => [new Polyline()],
        }],
      }),
    };
    const libs = { maps: { Map, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async (name) => libs[name] || {}, event: { trigger() {} } },
    };
  }, mapKey || '');

  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs || []).reduce((s, l) => s + (l.distanceKm || 0), 0);
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs ' + (priceCents * 3) },
      amountDueNow: { cents: Math.round(priceCents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'leg', amountCents: priceCents, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: (b.legs || []).map((l) => ({ priceCents: (l.distanceKm || 0) * 50 })) },
      fxUsdToLkr: 320,
      warnings: [],
      services: {
        pointToPoint: { total: { cents: priceCents, lkr: 'Rs 0' } },
        chauffeur: { error: 'single-day trip — point-to-point only' },
      },
    }));
  });
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/places**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') || '';
    r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
  });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
}

async function pickPlace(page, legIndex, field, name) {
  const stopSel = field === 'pickupLocation' ? '[data-field="stop"][data-stop="0"]'
    : field === 'dropoffLocation' ? '[data-field="stop"][data-stop="1"]'
    : '[data-field="' + field + '"]';
  const input = page.locator('.ch-tl-title' + stopSel).nth(legIndex);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
}

test('committing one change leaves unrelated DOM nodes untouched (no wholesale re-render)', async ({ page }) => {
  await stubOps(page, { mapKey: 'test-map-key' });

  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  // Leg 1 fully priced (renders the leg card, the money pane, and the itinerary map slot).
  await pickPlace(page, 0, 'pickupLocation', 'Colombo City');
  await pickPlace(page, 0, 'dropoffLocation', 'Kandy');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 10000 });

  // Tag nodes that the upcoming edit does NOT change. A JS property lives on the node
  // object itself, so it survives iff the node survives.
  const tagged = await page.evaluate(() => {
    const tag = (el) => { if (el) el.__stableTag = true; return !!el; };
    return {
      legCard: tag(document.querySelector('[data-leg-id]')),
      vehicleChip: tag(document.querySelector('[data-action="setVehicle"][data-veh="car"]')),
      mapSlot: tag(document.getElementById('itin-map-slot')),
      pickupInput: tag(document.querySelector('.ch-tl-title[data-field="stop"][data-stop="0"]')),
    };
  });
  expect(tagged).toEqual({ legCard: true, vehicleChip: true, mapSlot: true, pickupInput: true });

  // Commit an unrelated change: add a second leg (mutates the itinerary list + money pane).
  await page.getByText('Add leg').click();
  await expect(page.locator('[data-leg-id]')).toHaveCount(2);
  await page.waitForTimeout(600); // let the debounced estimate land + re-render

  const survived = await page.evaluate(() => ({
    legCard: !!(document.querySelector('[data-leg-id]') || {}).__stableTag,
    vehicleChip: !!(document.querySelector('[data-action="setVehicle"][data-veh="car"]') || {}).__stableTag,
    mapSlot: !!(document.getElementById('itin-map-slot') || {}).__stableTag,
    pickupInput: !!(document.querySelector('.ch-tl-title[data-field="stop"][data-stop="0"]') || {}).__stableTag,
  }));
  expect(survived).toEqual({ legCard: true, vehicleChip: true, mapSlot: true, pickupInput: true });
});

test('the itinerary map host is not re-parented by unrelated edits', async ({ page }) => {
  await stubOps(page, { mapKey: 'test-map-key' });

  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await pickPlace(page, 0, 'pickupLocation', 'Colombo City');
  await pickPlace(page, 0, 'dropoffLocation', 'Kandy');
  await expect(page.locator('#itin-map-slot')).toBeVisible({ timeout: 10000 });

  // The persistent map host (child of the slot) must stay in the SAME slot node across an
  // unrelated re-render — re-parenting it is what made the map visibly reload on every edit.
  await page.evaluate(() => {
    const slot = document.getElementById('itin-map-slot');
    slot.__slotTag = true;
    if (slot.firstElementChild) slot.firstElementChild.__hostTag = true;
  });

  await page.fill('#f-firstName', 'Someone');
  await page.dispatchEvent('#f-firstName', 'change');
  await page.waitForTimeout(600);

  const after = await page.evaluate(() => {
    const slot = document.getElementById('itin-map-slot');
    return {
      slotSurvived: !!(slot || {}).__slotTag,
      hostSurvived: !!(slot && slot.firstElementChild && slot.firstElementChild.__hostTag),
    };
  });
  expect(after).toEqual({ slotSurvived: true, hostSurvived: true });
});
