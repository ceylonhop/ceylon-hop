import { test, expect } from '@playwright/test';

// Diagnostic: does the leg date input collapse when chauffeur-guide is selected?
// Drives the real ops quote view with a stubbed API (no DB) on the offline webServer.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page) {
  await page.addInitScript(() => {
    function DS() {}
    DS.prototype.route = function (req, cb) { cb({ routes: [{ legs: [{ distance: { value: 120000 }, duration: { value: 7200 } }] }] }, 'OK'); };
    function DR() {} DR.prototype.setMap = function () {}; DR.prototype.setDirections = function () {};
    function M() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: M, DirectionsService: DS, DirectionsRenderer: DR, TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}) },
    };
  });
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 373, durationMin: 436 })));
}

async function setLegField(page, legIndex, field, value) {
  const input = page.locator('.ch-leg').nth(legIndex).locator(`[data-field="${field}"]`);
  await input.fill(value);
  await input.dispatchEvent('change');
  await page.waitForTimeout(80);
}

test('chauffeur mode does not collapse the leg date input', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  // The itinerary is gated until the trip basics are filled — set vehicle + name + contact.
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg-date input[type="date"]').first()).toBeVisible({ timeout: 10000 });

  // Faithful repro of the reported screenshot: long place names + set dates + 2 legs.
  await setLegField(page, 0, 'pickupLocation', 'Colombo Airport (CMB)');
  await setLegField(page, 0, 'dropoffLocation', 'Jaffna, Sri Lanka');
  await setLegField(page, 0, 'date', '2026-07-09');
  await page.getByText('Add leg').click();
  await page.waitForTimeout(120);
  await setLegField(page, 1, 'pickupLocation', 'Jaffna, Sri Lanka');
  await setLegField(page, 1, 'dropoffLocation', 'Colombo Airport (CMB)');
  await setLegField(page, 1, 'date', '2026-07-23');

  // Force chauffeur mode.
  await page.evaluate(() => {
    const btn = document.querySelector('[data-action="setService"][data-service="chauffeur"]');
    if (btn) { btn.disabled = false; btn.click(); }
  });
  await expect(page.locator('.ch-leg.is-chauffeur').first()).toBeVisible({ timeout: 5000 });

  // Fetch each leg's distance via the real distance control (set → auto) so both legs get
  // the wide "373 km · 7h16m" pill (matches the report) — the removed Travel|Stay toggle used
  // to be the trigger; the auto link on the distance field is the remaining UI path.
  for (let i = 0; i < 2; i++) {
    const leg = page.locator('.ch-leg').nth(i);
    await leg.locator('[data-action="manualDistance"]').click(); // reveals the "auto" link
    await leg.locator('[data-action="autoDistance"]').click();   // fetches the distance
    await page.waitForTimeout(150);
  }
  await expect(page.locator('.ch-dist-pill.auto').first()).toBeVisible({ timeout: 5000 });

  const dateInput = page.locator('.ch-leg-date input[type="date"]').first();
  const toInput = page.locator('.ch-leg').first().locator('[data-field="dropoffLocation"]');
  // The date input must never be overlapped/clipped by the "to" field (the reported bug: the
  // date shows only "/09/"). If space is tight the route drops to its own line instead.
  for (const width of [1280, 1100, 1000, 960, 900, 820]) {
    await page.setViewportSize({ width, height: 900 });
    await page.waitForTimeout(150);
    const d = await dateInput.boundingBox();
    const t = await toInput.boundingBox();
    const sameRow = d && t && Math.abs(d.y - t.y) < 12;
    const overlapPx = (d && t && sameRow) ? Math.round((t.x + t.width) - d.x) : 0;
    expect(overlapPx, `date/to overlap at viewport ${width}px`).toBeLessThanOrEqual(2);
  }
});
