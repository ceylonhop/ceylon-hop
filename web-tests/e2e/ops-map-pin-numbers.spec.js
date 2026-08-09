import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: the route map's pins were all identical teardrops, so a 12-stop
// itinerary gave no way to tell which pin was which stop. Each pin now carries its position in
// the journey, matching the numbered legs in the itinerary rail (leg N runs from pin N to N+1).
// Stubs google.maps and records every Marker's options so the labels can be asserted offline.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const RATE_CARD = {
  rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 }, van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 } },
  chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
};

// `legCount` controls how many legs the stubbed route returns → legCount + 1 pins.
async function stub(page, legCount = 3) {
  await page.addInitScript((n) => {
    window.OPS_MAPS_KEY = 'test-key';
    function Map(el) { this.__el = el; if (el) el.setAttribute('data-map', 'ready'); }
    Map.prototype.fitBounds = function () {};
    // Required since pins became zoom-aware (2026-08-07): without getZoom/addListener the pin
    // pass throws into its "markers are non-essential" catch and every assertion below sees an
    // empty marker list — these tests were passing vacuously until they weren't.
    Map.prototype.getZoom = function () { return 10; };
    Map.prototype.addListener = function () { return { remove() {} }; };
    function Marker(opts) { (window.__markers = window.__markers || []).push(opts); }
    Marker.prototype.setMap = function () {};
    function Point(x, y) { this.x = x; this.y = y; }
    function Polyline() {}
    Polyline.prototype.setOptions = function () {};
    Polyline.prototype.setMap = function () {};
    const legs = [];
    for (let i = 0; i < n; i++) {
      legs.push({ startLocation: { lat: 6.9 + i, lng: 79.8 + i }, endLocation: { lat: 7.9 + i, lng: 80.8 + i } });
    }
    const Route = {
      computeRoutes: async () => ({
        routes: [{ path: [], viewport: {}, legs, createPolylines: () => [new Polyline()] }],
      }),
    };
    const libs = { maps: { Map, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async (name) => libs[name] || {}, event: { trigger() {} } },
    };
  }, legCount);
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({ product: 'private', total: { cents: 12100, lkr: 'x' }, lineItems: [], breakdown: { km: {} }, services: { pointToPoint: { total: { cents: 12100 } }, chauffeur: { error: 'x' } }, warnings: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
}

async function buildRoute(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Karen');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await page.waitForSelector('.ch-tl-title[data-field="stop"][data-stop="0"]', { timeout: 10000 });
  const from = page.locator('.ch-tl-title[data-field="stop"][data-stop="0"]').first();
  const to = page.locator('.ch-tl-title[data-field="stop"][data-stop="1"]').first();
  await from.fill('Colombo'); await from.dispatchEvent('change');
  await to.fill('Kandy'); await to.dispatchEvent('change');
}

const markers = (page) => page.evaluate(() => window.__markers || []);

test('every map pin carries its stop number, in journey order', async ({ page }) => {
  test.slow();
  await stub(page, 3); // 3 legs → 4 pins
  await buildRoute(page);

  await expect.poll(async () => (await markers(page)).length, { timeout: 15000 }).toBe(4);
  const opts = await markers(page);
  expect(opts.map((m) => m.label && m.label.text)).toEqual(['1', '2', '3', '4']);
});

test('the number sits in the pin head and is legible on the fill', async ({ page }) => {
  test.slow();
  await stub(page, 1); // 1 leg → 2 pins
  await buildRoute(page);

  await expect.poll(async () => (await markers(page)).length, { timeout: 15000 }).toBe(2);
  const [first] = await markers(page);
  expect(first.label.color).toBe('#fff');
  expect(first.label.fontWeight).toBe('700');
  // Without labelOrigin the label centres on the anchor — the pin's TIP — and floats off it.
  // (12, 10) is the centre of the teardrop's head in the icon path's own coordinates.
  expect(first.icon.labelOrigin).toMatchObject({ x: 12, y: 10 });
});

test('the start and end pins keep their distinct colours', async ({ page }) => {
  test.slow();
  await stub(page, 2); // 2 legs → 3 pins
  await buildRoute(page);

  await expect.poll(async () => (await markers(page)).length, { timeout: 15000 }).toBe(3);
  const opts = await markers(page);
  expect(opts[0].icon.fillColor).toBe('#0a7d6f'); // journey start
  expect(opts[1].icon.fillColor).toBe('#0AB9B6'); // in between
  expect(opts[2].icon.fillColor).toBe('#e8623a'); // journey end
  // Numbering is unaffected by the colour banding.
  expect(opts.map((m) => m.label.text)).toEqual(['1', '2', '3']);
});
