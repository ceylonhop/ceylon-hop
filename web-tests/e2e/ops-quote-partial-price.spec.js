import { test, expect } from '@playwright/test';

// Defect A: adding an incomplete leg must NOT blank the prices of the legs that are ready.
// The estimate is point-to-point (each leg prices independently), so a half-built leg should
// be excluded from pricing — the ready legs keep their running total — not poison the whole
// request. Stub mirrors the real engine: any driving leg without a distance errors the request.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page) {
  await page.addInitScript(() => {
    function DirectionsService() {}
    DirectionsService.prototype.route = function (req, cb) {
      cb({ routes: [{ legs: [{ distance: { value: 120000 }, duration: { value: 7200 } }] }] }, 'OK');
    };
    function DirectionsRenderer() {}
    DirectionsRenderer.prototype.setMap = function () {};
    DirectionsRenderer.prototype.setDirections = function () {};
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: MapCls, DirectionsService, DirectionsRenderer,
        TravelMode: { DRIVING: 'DRIVING' },
        places: {
          AutocompleteSessionToken: function () {},
          AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
        },
        importLibrary: async () => ({}),
      },
    };
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  // Mirror the engine: a driving leg with no distance can't be priced → the whole request errors.
  // Otherwise price at 50¢/km and return per-leg priceCents (breakdown.legs is per DRIVING leg).
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const driving = (b.legs || []).filter((l) => l.category !== 'stay_day');
    if (driving.some((l) => !(l.distanceKm > 0))) return r.fulfill(json({ error: 'unknown distance' }));
    let total = 0;
    const blegs = driving.map((l) => { const c = Math.round((l.distanceKm || 0) * 50); total += c; return { priceCents: c }; });
    const km = driving.reduce((s, l) => s + (l.distanceKm || 0), 0);
    return r.fulfill(json({
      total: { cents: total, lkr: 'Rs ' + total * 3 },
      amountDueNow: { cents: Math.round(total / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'Private transfer', amountCents: total, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: blegs },
      fxUsdToLkr: 320, warnings: [],
      services: { pointToPoint: { total: { cents: total, lkr: 'Rs 0' } }, chauffeur: { error: 'single-day trip — point-to-point only' } },
    }));
  });
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/places**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') || '';
    r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
  });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
}

function stopSel(field) {
  if (field === 'from') return '[data-field="stop"][data-stop="0"]';
  return '[data-field="stop"][data-stop="1"]';
}
async function pickPlace(page, legIndex, field, name) {
  const input = page.locator('.ch-leg').nth(legIndex).locator('.ch-tl-title' + stopSel(field));
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
}

test('adding an empty leg keeps the ready legs priced (does not blank the total)', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  // One complete leg → 120 km × 50¢ = $60.00 total.
  await pickPlace(page, 0, 'from', 'Colombo City');
  await pickPlace(page, 0, 'to', 'Kandy');
  await expect(page.locator('.ch-total-usd').first()).toHaveText('$60.00', { timeout: 10000 });

  // Add a second, empty leg — the ready leg's price MUST survive.
  await page.getByText('Add leg').click();
  await page.waitForTimeout(600); // let the debounced estimate settle

  // The total still shows the ready leg's price — NOT the em-dash "To price" fallback.
  await expect(page.locator('.ch-total-usd').first()).toHaveText('$60.00');
  await expect(page.locator('.ch-total-usd.pending')).toHaveCount(0);
});
