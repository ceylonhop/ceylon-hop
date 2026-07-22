import { test, expect } from '@playwright/test';

// Drives the REAL ops quote builder (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
// Regression for design-review D5: clicking "← Queue" on an unsaved quote discarded everything
// with no confirmation. In-app back navigation now honours the same unsaved-changes guard as
// "+ New quote" and the browser's beforeunload.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stub(page) {
  await page.addInitScript(() => {
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: MapCls, places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } }, importLibrary: async () => ({}) },
    };
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs 0' }, amountDueNow: { cents: 0, lkr: 'Rs 0' },
      lineItems: [], breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: [{ priceCents }] },
      fxUsdToLkr: 320, warnings: [], services: { pointToPoint: { total: { cents: priceCents, lkr: 'Rs 0' } }, chauffeur: { error: 'x' } },
    }));
  });
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/quotes**', (r) => r.fulfill(json({ quotes: [] })));
}

test('D5: "← Queue" on an unsaved quote asks before discarding, and dismiss keeps the builder', async ({ page }) => {
  await stub(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Make the builder dirty (unsaved edits: vehicle + name).
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.dispatchEvent('#f-firstName', 'change');

  // First click: dismiss the confirm → we must STAY in the builder (no discard).
  let asked = 0;
  page.once('dialog', (d) => { asked++; expect(d.message()).toContain('Unsaved changes'); d.dismiss(); });
  await page.locator('[data-action="backToQueue"]').click();
  expect(asked).toBe(1);
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible();
  await expect(page.locator('#f-firstName')).toHaveValue('Test');

  // Second click: accept the confirm → navigation proceeds to the queue.
  page.once('dialog', (d) => d.accept());
  await page.locator('[data-action="backToQueue"]').click();
  await expect(page.locator('#view [data-qnew]')).toBeVisible({ timeout: 5000 });
});
