import { test, expect } from '@playwright/test';

// Positive location identification (spec 2026-08-02). Q-CEVGM priced Yala -> Colombo Airport at
// 78 km instead of ~286 because the stop string was handed to Google's geocoder, which resolved
// it to a village near Horana. The server now refuses to guess and reports the endpoint as
// unresolved; the builder must SAY so and let the operator identify it once.
// Drives the real ops quote view with a stubbed API (no DB) on the offline webServer.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page, opts = {}) {
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

  // Registered FIRST on purpose: Playwright tries the most recently added route first, so the
  // catch-all must go on before the specific ones or it swallows whoami and the page never boots.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));

  // Distance: reports the unknown endpoint as unresolved, exactly as the server now does.
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json(
    opts.resolved ? { km: 286, durationMin: 300 } : { km: 78, durationMin: 100, unresolved: ['Yala, Sri Lanka'] },
  )));
  await page.route('**/admin/quote/place-candidates**', (r) => r.fulfill(json({
    candidates: [
      { displayName: 'Yala, Sri Lanka', lat: 6.664, lng: 80.0706, area: 'Western Province', kmFromPrevious: 240 },
      { displayName: 'Yala National Park', lat: 6.464, lng: 81.4719, area: 'Southern Province', kmFromPrevious: 175 },
    ],
  })));
  // A realistic estimate payload. The rail reads est.total.cents; with the bare {} the other
  // offline specs use, render() throws and the builder never redraws — which is exactly how
  // this spec first failed.
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({
    total: { cents: 28600, usd: '$286.00', lkr: 'LKR 94,380' },
    km: 286, durationMin: 300,
    lineItems: [{ label: 'Yala, Sri Lanka → Colombo Airport (CMB) (car)', amountCents: 28600, usd: '$286.00', lkr: 'LKR 94,380' }],
    services: { pointToPoint: { error: 'n/a' }, chauffeur: { error: 'single-day — point-to-point only' } },
  })));
  await page.route('**/admin/quote/place-confirm', (r) => r.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ canonKey: 'yala' }) }));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
}

async function setLeg(page, from, to) {
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  for (const [stop, value] of [[0, from], [1, to]]) {
    const input = page.locator('.ch-leg').first().locator(`[data-field="stop"][data-stop="${stop}"]`);
    await input.fill(value);
    await input.dispatchEvent('change');
    await page.waitForTimeout(120);
  }
}

test('a distance measured from a name is flagged, and can be identified once', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await setLeg(page, 'Yala, Sri Lanka', 'Colombo Airport (CMB)');

  // The leg must not present 78 km as a settled fact.
  const confirm = page.locator('[data-action="confirmPlace"]');
  await expect(confirm).toBeVisible({ timeout: 10000 });

  await confirm.click();

  // Google labels BOTH Yalas as plain "Sri Lanka", so the panel has to lead with what actually
  // separates them: the administrative area and the distance from the previous stop.
  await expect(page.locator('.ch-cand')).toHaveCount(2);
  await expect(page.locator('.ch-cand').first()).toContainText('Western Province');
  await expect(page.locator('.ch-cand').first()).toContainText('240 km from the previous stop');
  await expect(page.locator('.ch-cand').nth(1)).toContainText('Southern Province');

  // Identify it. The POST must carry the coordinates of the chosen place, not the typed name.
  const [request] = await Promise.all([
    page.waitForRequest((r) => r.url().includes('/place-confirm') && r.method() === 'POST'),
    page.locator('.ch-cand').nth(1).click(),
  ]);
  expect(JSON.parse(request.postData())).toMatchObject({
    name: 'Yala, Sri Lanka',
    displayName: 'Yala National Park',
    lat: 6.464,
    lng: 81.4719,
  });

  // Warning clears, and the panel closes.
  await expect(page.locator('.ch-cand')).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
});

test('no flag is shown when the server identified both endpoints', async ({ page }) => {
  await stubOps(page, { resolved: true });
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await setLeg(page, 'Kandy', 'Ella');
  await page.waitForTimeout(600);
  await expect(page.locator('[data-action="confirmPlace"]')).toHaveCount(0);
});
