import { test, expect } from '@playwright/test';

// Regression for the reported bug: a chauffeur quote with SOME legs dated and some not
// (2+ distinct dates, so it isn't downgraded to point-to-point) fired /admin/quote/save,
// which the server 400s ("chauffeur trips need a date on every leg") into a fleeting toast.
// The fix flags the undated legs, surfaces the reason in the needs line, and blocks the
// doomed save/estimate up front. Drives the real ops SPA with a stubbed API (no DB).

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page, counters) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () { this.setMap = function () {}; this.setDirections = function () {}; },
        TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}),
      },
    };
  });
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  // Register the broad catch-all FIRST: Playwright matches page.route handlers in reverse
  // registration order (last-registered wins), so the specific stubs below must come AFTER it —
  // otherwise the catch-all's {} shadows /admin/ops/whoami and the ops SPA never boots.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/save', (r) => { counters.save++; r.fulfill(json({ id: 'q1', reference: 'Q-TEST', status: 'draft' })); });
  await page.route('**/admin/quote/estimate', (r) => { counters.estimate++; r.fulfill(json({ error: 'chauffeur trips need a date on every leg (including stay days)' })); });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 180, durationMin: 200 })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 }, chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
}

// Multi-stop rides (Task 8): pickup/dropoff are stop 0 / the last stop of a 2-stop leg,
// addressed via data-field="stop" + data-stop. Translate the legacy field names.
function stopSelector(field) {
  if (field === 'pickupLocation') return '[data-field="stop"][data-stop="0"]';
  if (field === 'dropoffLocation') return '[data-field="stop"][data-stop="1"]';
  return `[data-field="${field}"]`;
}
async function setLegField(page, i, field, value) {
  const input = page.locator('.ch-leg').nth(i).locator(stopSelector(field));
  await input.fill(value);
  await input.dispatchEvent('change');
  await page.waitForTimeout(60);
}

test('chauffeur save is blocked (not a silent 400) when a leg has no date', async ({ page }) => {
  test.slow();
  const counters = { save: 0, estimate: 0 };
  await stubOps(page, counters);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="van_6"]').click();
  await page.fill('#f-firstName', 'Diana');
  await page.fill('#f-lastName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg-date input[type="date"]').first()).toBeVisible({ timeout: 10000 });

  // 3 legs: date leg 0 (day 1) and leg 2 (day 2) — distinct — but leave leg 1 UNDATED.
  await setLegField(page, 0, 'pickupLocation', 'Colombo, Sri Lanka');
  await setLegField(page, 0, 'dropoffLocation', 'Ella, Sri Lanka');
  await setLegField(page, 0, 'date', '2026-10-01');
  await page.getByText('Add leg').click(); await page.waitForTimeout(100);
  await setLegField(page, 1, 'pickupLocation', 'Ella, Sri Lanka');
  await setLegField(page, 1, 'dropoffLocation', 'Galle, Sri Lanka'); // no date
  await page.getByText('Add leg').click(); await page.waitForTimeout(100);
  await setLegField(page, 2, 'pickupLocation', 'Galle, Sri Lanka');
  await setLegField(page, 2, 'dropoffLocation', 'Colombo, Sri Lanka');
  await setLegField(page, 2, 'date', '2026-10-07');

  // Give every leg a distance so the ONLY thing missing is a date on leg 1.
  for (let i = 0; i < 3; i++) {
    const leg = page.locator('.ch-leg').nth(i);
    await leg.locator('[data-action="manualDistance"]').click();
    await leg.locator('[data-action="autoDistance"]').click();
    await page.waitForTimeout(120);
  }

  // Force chauffeur.
  await page.evaluate(() => { const b = document.querySelector('[data-action="setService"][data-service="chauffeur"]'); if (b) { b.disabled = false; b.click(); } });
  await page.waitForTimeout(400);

  // The undated leg (leg 1) is flagged, and the needs line names the missing date.
  await expect(page.locator('.ch-leg').nth(1).locator('.ch-leg-date.invalid')).toBeVisible({ timeout: 5000 });
  await expect(page.locator('.ch-needs')).toContainText(/date/i);

  // The doomed estimate was NOT fired for the undated-chauffeur state.
  const estimateBefore = counters.estimate;
  await page.locator('[data-action="saveDraft"]').click();
  await page.waitForTimeout(300);
  expect(counters.save, 'save must be blocked client-side, not sent as a doomed 400').toBe(0);

  // Fill the missing date → the block clears and a save can go through.
  await setLegField(page, 1, 'date', '2026-10-04');
  await page.waitForTimeout(300);
  await expect(page.locator('.ch-leg-date.invalid')).toHaveCount(0);
  await page.locator('[data-action="saveDraft"]').click();
  await page.waitForTimeout(300);
  expect(counters.save, 'save fires once all legs are dated').toBeGreaterThan(0);
});
