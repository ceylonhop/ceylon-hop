import { test, expect } from '@playwright/test';

// Vehicle is the required first choice: it lives in the Trip basics section (with the customer
// fields), and it GATES the itinerary — you can't build the trip until a vehicle is picked.
// The no-vehicle state must be loud (amber chips + locked itinerary) — never the false all-clear.

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

test('vehicle chips live in Trip basics (above the itinerary), not the money pane', async ({ page }) => {
  await openQuote(page);
  const chips = page.locator('.ch-cust-strip [data-action="setVehicle"]');
  await expect(chips).toHaveCount(5);
  await expect(chips.first()).toContainText('Car');
  await expect(page.locator('.ch-money-card [data-action="setVehicle"]')).toHaveCount(0); // moved out of the money pane
  await expect(page.locator('#f-vehicleType')).toHaveCount(0); // no legacy select
  // chips sit ABOVE the itinerary section
  const chipBox = await page.locator('#veh-chips').boundingBox();
  const itinBox = await page.locator('.ch-sec').first().boundingBox();
  expect(chipBox.y).toBeLessThan(itinBox.y);
});

test('the itinerary is locked until a vehicle is chosen', async ({ page }) => {
  await openQuote(page);
  await expect(page.locator('.ch-itin-locked')).toBeVisible();
  await expect(page.locator('.ch-itin-locked')).toContainText(/pick a vehicle/i);
  await expect(page.locator('[data-action="addLeg"]')).toHaveCount(0); // can't add legs yet
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await expect(page.locator('.ch-itin-locked')).toHaveCount(0); // unlocked
  await expect(page.locator('[data-action="addLeg"]')).toBeVisible();
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

test('Van 14 and Custom price from the rate card — no per-quote $/km input', async ({ page }) => {
  await openQuote(page);
  await page.locator('[data-action="setVehicle"][data-veh="van_14"]').click();
  await expect(page.locator('#f-customRate')).toHaveCount(0); // input removed — rate lives in the rate card
  await expect(page.locator('[data-action="setVehicle"][data-veh="van_14"]')).toHaveClass(/active/);
  await page.locator('[data-action="setVehicle"][data-veh="custom"]').click();
  await expect(page.locator('#f-customRate')).toHaveCount(0);
  // Still prices (from the rate card) — the money pane shows a total, no rate entry needed.
  await expect(page.locator('.ch-line.strong .ch-line-val').first()).toContainText('$', { timeout: 8000 });
});
