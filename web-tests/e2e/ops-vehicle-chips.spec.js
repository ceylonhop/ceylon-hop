import { test, expect } from '@playwright/test';

// Vehicle is a PRICING decision: it lives in the money pane as a chip row above the service
// chooser (spec: 2026-07-09-ops-vehicle-decision-stack-design.md), not in the customer header.
// The no-vehicle state must be loud (warning card, amber chips) — never the false all-clear.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function openQuote(page) {
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 }, van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 } },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({
    product: 'private',
    total: { cents: 12100, lkr: 'LKR 39,930' },
    lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 12100, lkr: 'LKR 39,930' }],
    breakdown: { km: { distanceKm: 120, bufferKm: 12, billableKm: 132 }, legs: [{ cents: 12100 }] },
    services: { pointToPoint: { total: { cents: 12100, lkr: 'LKR 39,930' } }, chauffeur: { error: 'single-day trip — point-to-point only' } },
    warnings: [],
  })));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
}

test('vehicle chips live in the money pane; header has no vehicle select', async ({ page }) => {
  await openQuote(page);
  const chips = page.locator('.ch-money-card [data-action="setVehicle"]');
  await expect(chips).toHaveCount(5);
  await expect(chips.first()).toContainText('Car');
  await expect(page.locator('#f-vehicleType')).toHaveCount(0); // gone from the header
  // chips sit ABOVE the service chooser inside the same card
  const chipBox = await page.locator('#veh-chips').boundingBox();
  const svcBox = await page.locator('.ch-svc-choose').boundingBox();
  expect(chipBox.y).toBeLessThan(svcBox.y);
});

test('no vehicle → real warning card, amber chips, no false all-clear', async ({ page }) => {
  await openQuote(page);
  await expect(page.locator('#veh-chips')).toHaveClass(/unset/);
  await expect(page.locator('#veh-chips')).toContainText('Pick a vehicle');
  await expect(page.locator('#quoteRoot .ch-app')).toContainText('Vehicle not set');
  await expect(page.locator('.ch-flags-clear')).toHaveCount(0); // never "looks clean to send"
});

test('clicking a chip selects, prices, and clears the vehicle warning', async ({ page }) => {
  await openQuote(page);
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await expect(page.locator('[data-action="setVehicle"][data-veh="car"]')).toHaveClass(/active/);
  await expect(page.locator('#veh-chips')).not.toHaveClass(/unset/);
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('$121.00', { timeout: 8000 });
  await expect(page.locator('#quoteRoot .ch-app')).not.toContainText('Vehicle not set');
});

test('a chip too small for the pax count shows a seats warning but stays clickable', async ({ page }) => {
  await openQuote(page);
  await page.fill('#f-passengerCount', '5');
  await page.dispatchEvent('#f-passengerCount', 'change');
  const car = page.locator('[data-action="setVehicle"][data-veh="car"]');
  await expect(car).toHaveClass(/over/);
  await expect(car).toContainText('seats 3');
  await car.click(); // still selectable — capacity warning framework handles the flag
  await expect(car).toHaveClass(/active/);
});

test('Van 14 reveals the Rate $/km input under the chips', async ({ page }) => {
  await openQuote(page);
  await page.locator('[data-action="setVehicle"][data-veh="van_14"]').click();
  const rate = page.locator('.ch-money-card #f-customRate');
  await expect(rate).toBeVisible();
  const rateBox = await rate.boundingBox();
  const svcBox = await page.locator('.ch-svc-choose').boundingBox();
  expect(rateBox.y).toBeLessThan(svcBox.y); // sits with the chips, above the service boxes
});
