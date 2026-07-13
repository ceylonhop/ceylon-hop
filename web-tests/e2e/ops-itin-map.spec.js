import { test, expect } from '@playwright/test';

// Interactive route map at the foot of the itinerary. The real map needs Google Maps JS +
// a browser key (templated server-side); here we force a key via window.OPS_MAPS_KEY and
// stub google.maps so the render path is exercised offline without hitting Google.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const RATE_CARD = {
  rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 }, van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 } },
  chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
};

// Install a minimal google.maps stub that records that a Map + route were created, and
// (optionally) a forced browser key so the ops map code treats the key as configured.
async function stub(page, { key } = {}) {
  await page.addInitScript((k) => {
    if (k) window.OPS_MAPS_KEY = k;
    function Map(el) { this.__el = el; if (el) el.setAttribute('data-map', 'ready'); }
    Map.prototype.fitBounds = function () {};
    function DS() {}
    DS.prototype.route = function (req, cb) { cb({ routes: [{ legs: [{ start_location: {}, end_location: {} }], bounds: {} }] }, 'OK'); };
    function DR() {}
    DR.prototype.setDirections = function () {};
    function Marker() {}
    function Point() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map, DirectionsService: DS, DirectionsRenderer: DR, Marker, Point, TravelMode: { DRIVING: 'DRIVING' }, event: { trigger() {} }, importLibrary: async () => ({}) },
    };
  }, key || '');
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({ product: 'private', total: { cents: 12100, lkr: 'x' }, lineItems: [], breakdown: { km: {} }, services: { pointToPoint: { total: { cents: 12100 } }, chauffeur: { error: 'x' } }, warnings: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
}

// Fill the trip basics + two named stops so the itinerary has a routable path.
async function buildRoute(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Karen');
  await page.fill('#f-lastName', 'Silva');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await page.waitForSelector('.ch-tl-title[data-field="pickupLocation"]', { timeout: 10000 });
  const from = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  const to = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await from.fill('Colombo'); await from.dispatchEvent('change');
  await to.fill('Kandy'); await to.dispatchEvent('change');
}

test('the route map is collapsed behind a toggle and opens on click', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stub(page, { key: 'test-browser-key' });
  await buildRoute(page);
  // Two stops → the toggle appears, but the map does NOT auto-open (no jarring pop-in).
  await expect(page.locator('.ch-map-toggle')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#itin-map-slot')).toHaveCount(0);
  // Clicking the toggle reveals the map.
  await page.locator('.ch-map-toggle').click();
  await expect(page.locator('#itin-map-slot')).toBeVisible();
  await expect(page.locator('.ch-itin-map[data-map="ready"]')).toBeVisible({ timeout: 10000 });
  // And it collapses again.
  await page.locator('.ch-map-toggle').click();
  await expect(page.locator('#itin-map-slot')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('without a maps key the itinerary shows no route map toggle', async ({ page }) => {
  await stub(page); // no key → OPS_MAPS_KEY stays the untemplated placeholder → treated as none
  await buildRoute(page);
  await expect(page.locator('.ch-leg').first()).toBeVisible();
  await expect(page.locator('.ch-map-toggle')).toHaveCount(0);
  await expect(page.locator('#itin-map-slot')).toHaveCount(0);
});
