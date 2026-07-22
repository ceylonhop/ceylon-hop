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
// Mirrors the async-loaded API: classes come ONLY from importLibrary (no google.maps.Map
// namespace access), and routing is the new routes library's Route.computeRoutes — the
// legacy DirectionsService/DirectionsRenderer are deliberately absent so any lingering
// use of them throws and fails the no-pageerror assertion. Each computeRoutes request is
// recorded on window.__computeRoutesReqs so tests can assert the known-places-by-coords rule.
async function stub(page, { key } = {}) {
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
      computeRoutes: async (req) => {
        (window.__computeRoutesReqs = window.__computeRoutesReqs || []).push(req);
        if (window.__failRoutes) return { routes: [] }; // test knob: unroutable itinerary
        return {
          routes: [{
            path: [],
            viewport: {},
            legs: [{ startLocation: { lat: 6.93, lng: 79.85 }, endLocation: { lat: 7.29, lng: 80.63 } }],
            createPolylines: () => [new Polyline()],
          }],
        };
      },
    };
    const libs = { maps: { Map, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async (name) => libs[name] || {}, event: { trigger() {} } },
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
  await page.waitForSelector('.ch-tl-title[data-field="stop"][data-stop="0"]', { timeout: 10000 });
  const from = page.locator('.ch-tl-title[data-field="stop"][data-stop="0"]').first();
  const to = page.locator('.ch-tl-title[data-field="stop"][data-stop="1"]').first();
  await from.fill('Colombo'); await from.dispatchEvent('change');
  await to.fill('Kandy'); await to.dispatchEvent('change');
}

test('the route map is open by default and folds behind the toggle', async ({ page }) => {
  test.slow(); // heavy ops SPA boot — give it headroom so it doesn't time out under parallel load
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await stub(page, { key: 'test-browser-key' });
  await buildRoute(page);
  // Two stops → the toggle appears and the map is open by default (owner request, commit 215e027:
  // _mapOpen defaults to true). The toggle folds it away and reopens it.
  await expect(page.locator('.ch-map-toggle')).toBeVisible({ timeout: 10000 });
  await expect(page.locator('#itin-map-slot')).toBeVisible();
  await expect(page.locator('.ch-itin-map[data-map="ready"]')).toBeVisible({ timeout: 10000 });
  // Clicking the toggle collapses the map.
  await page.locator('.ch-map-toggle').click();
  await expect(page.locator('#itin-map-slot')).toHaveCount(0);
  // Clicking it again reopens the map.
  await page.locator('.ch-map-toggle').click();
  await expect(page.locator('#itin-map-slot')).toBeVisible();
  await expect(page.locator('.ch-itin-map[data-map="ready"]')).toBeVisible({ timeout: 10000 });
  // The route was computed via the new routes library, resolving stops per the repo rule:
  // a known place ("Kandy") goes to Google as its exact coords — bare names can geocode
  // outside Sri Lanka — while a free-typed name ("Colombo" isn't in the known-place table)
  // stays a string anchored to ", Sri Lanka".
  const reqs = await page.evaluate(() => window.__computeRoutesReqs || []);
  expect(reqs.length).toBeGreaterThan(0);
  expect(reqs[reqs.length - 1].origin).toBe('Colombo, Sri Lanka');
  expect(reqs[reqs.length - 1].destination).toEqual({ lat: 7.29, lng: 80.63 });
  expect(errors).toEqual([]);
});

test('a failed route does not re-query on unrelated edits — only a stop change retries', async ({ page }) => {
  test.slow(); // heavy ops SPA boot — headroom under parallel load
  await stub(page, { key: 'test-browser-key' });
  // Every computeRoutes returns no routes → the map lands in its failed state
  // ("Couldn't map this route"). In that state _mapMap stays null, and syncItinMap
  // used to re-fire a full billable route query on EVERY render — every date change,
  // price keystroke, or checkbox — retrying an itinerary that can't succeed until a
  // stop actually changes.
  await page.addInitScript(() => { window.__failRoutes = true; });
  await buildRoute(page);
  await expect(page.locator('.ch-itin-map-note')).toContainText(/map this route/, { timeout: 10000 });
  await page.waitForTimeout(1000); // let boot-time renders + the estimate debounce settle
  const before = await page.evaluate(() => (window.__computeRoutesReqs || []).length);

  // A date-only change re-renders (twice: immediately + after the estimate) but must
  // NOT re-query — the stops didn't change, so the route would just fail again.
  await page.$eval('input[type="date"][data-field="date"]', (el) => {
    el.value = '2026-08-10';
    el.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await page.waitForTimeout(1000);
  const afterDate = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  expect(afterDate).toBe(before);

  // Changing an actual stop is the only thing that can fix a failed route → exactly
  // that triggers a retry.
  const to = page.locator('.ch-tl-title[data-field="stop"][data-stop="1"]').first();
  await to.fill('Ella');
  await to.dispatchEvent('change');
  await expect
    .poll(() => page.evaluate(() => (window.__computeRoutesReqs || []).length), { timeout: 5000 })
    .toBeGreaterThan(afterDate);
});

test('without a maps key the itinerary shows no route map toggle', async ({ page }) => {
  test.slow(); // heavy ops SPA boot — headroom under parallel load
  await stub(page); // no key → OPS_MAPS_KEY stays the untemplated placeholder → treated as none
  await buildRoute(page);
  await expect(page.locator('.ch-leg').first()).toBeVisible();
  await expect(page.locator('.ch-map-toggle')).toHaveCount(0);
  await expect(page.locator('#itin-map-slot')).toHaveCount(0);
});
