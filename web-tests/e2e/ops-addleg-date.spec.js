import { test, expect } from '@playwright/test';

// Adding a leg must NOT auto-fill its date. Auto-incrementing the previous leg's date
// (+1 day) invented dates the customer never gave — a 4-leg itinerary looked fully
// scheduled when only the first leg had been dated. A new leg starts blank; the operator
// dates each one. (Pickup still chains from the previous leg's drop-off — that IS wanted.)
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
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 152, durationMin: 190 })));
}

// Multi-stop rides (Task 8): pickup/dropoff are stop 0 / the last stop of a 2-stop leg,
// addressed via data-field="stop" + data-stop. Translate the legacy field names.
function stopSelector(field) {
  if (field === 'pickupLocation') return '[data-field="stop"][data-stop="0"]';
  if (field === 'dropoffLocation') return '[data-field="stop"][data-stop="1"]';
  return `[data-field="${field}"]`;
}
async function setLegField(page, legIndex, field, value) {
  const input = page.locator('.ch-leg').nth(legIndex).locator(stopSelector(field));
  await input.fill(value);
  await input.dispatchEvent('change');
  await page.waitForTimeout(80);
}

test('adding a leg leaves its date blank (no auto-increment) but chains the pickup', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Itinerary is gated until the trip basics are filled.
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg-date input[type="date"]').first()).toBeVisible({ timeout: 10000 });

  // Date the first leg and give it a drop-off, then add a second leg.
  await setLegField(page, 0, 'pickupLocation', 'Colombo Airport (CMB)');
  await setLegField(page, 0, 'dropoffLocation', 'Sigiriya / Dambulla');
  await setLegField(page, 0, 'date', '2026-07-21');
  await page.getByText('Add leg').click();
  await page.waitForTimeout(120);

  // The new leg's date must be blank — NOT 2026-07-22 (the old +1-day auto-increment).
  const secondDate = page.locator('.ch-leg').nth(1).locator('[data-field="date"]');
  await expect(secondDate).toHaveValue('');

  // Pickup still chains from the previous leg's drop-off (unchanged, wanted behavior).
  const secondPickup = page.locator('.ch-leg').nth(1).locator('[data-field="stop"][data-stop="0"]');
  await expect(secondPickup).toHaveValue('Sigiriya / Dambulla');
});
