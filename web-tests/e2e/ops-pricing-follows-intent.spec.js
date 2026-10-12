import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// "Customer asked for" decides how a quote is priced (owner, 2026-10-12). The builder had two
// controls — what the customer asked for, and a pair of clickable "Pricing as" cards — and they
// could disagree: pick Chauffeur-guide BEFORE the itinerary has two dated days (the natural order,
// the control sits above the itinerary), the estimate silently reverts the price to point-to-point,
// and nothing ever moves it back. The owner approved such a quote on staging: asked for chauffeur,
// priced $185 point-to-point. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const BOTH_PRICED = {
  services: {
    pointToPoint: { total: { cents: 18500, lkr: 'LKR 61,050' } },
    chauffeur: { total: { cents: 29900, lkr: 'LKR 98,670' } },
  },
};

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
  await routeOpsEstimate(page, BOTH_PRICED);
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 175, durationMin: 240 })));
}

async function openBuilder(page) {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg-date input[type="date"]').first()).toBeVisible({ timeout: 10000 });
}
const askedFor = (page, req) => page.locator(`[data-action="setRequestedService"][data-req="${req}"]`);
const activeCard = (page) => page.locator('.ch-svc-box.active .ch-svc-lbl');
async function setLeg(page, i, from, to, date) {
  const leg = page.locator('.ch-leg').nth(i);
  for (const [sel, v] of [['[data-field="stop"][data-stop="0"]', from], ['[data-field="stop"][data-stop="1"]', to], ['[data-field="date"]', date]]) {
    const input = leg.locator(sel);
    await input.fill(v);
    await input.dispatchEvent('change');
    await page.waitForTimeout(80);
  }
}
const futureDates = (page) => page.evaluate(() => {
  const iso = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };
  return [iso(30), iso(33)];
});

test('Chauffeur-guide picked BEFORE the itinerary exists still ends up priced as chauffeur', async ({ page }) => {
  test.slow();
  await openBuilder(page);
  const [d1, d2] = await futureDates(page);

  // The owner's order: say what the customer asked for first…
  await askedFor(page, 'chauffeur').click();
  // …a one-day itinerary cannot be a chauffeur trip yet, so it is priced point-to-point for now,
  // and the page says why instead of calling it a mismatch.
  await expect(activeCard(page)).toHaveText('Point-to-point', { timeout: 5000 });
  await expect(page.locator('.ch-req-mismatch')).toContainText('2 or more travel days');

  // …then build the trip. Two dated days make it a chauffeur trip — and the price must follow.
  await setLeg(page, 0, 'Colombo Airport (CMB)', 'Anuradhapura', d1);
  await page.getByText('Add leg').click();
  await page.waitForTimeout(120);
  await setLeg(page, 1, 'Anuradhapura', 'Bentota', d2);

  await expect(activeCard(page)).toHaveText('Chauffeur-guide', { timeout: 8000 });
  await expect(page.locator('.ch-leg.is-chauffeur').first()).toBeVisible();
  await expect(page.locator('.ch-req-mismatch')).toHaveCount(0);
});

test('the Pricing as cards are display-only: nothing to click, and clicking changes nothing', async ({ page }) => {
  test.slow();
  await openBuilder(page);
  const [d1, d2] = await futureDates(page);
  await setLeg(page, 0, 'Colombo Airport (CMB)', 'Anuradhapura', d1);
  await page.getByText('Add leg').click();
  await page.waitForTimeout(120);
  await setLeg(page, 1, 'Anuradhapura', 'Bentota', d2);
  await askedFor(page, 'chauffeur').click();
  await expect(activeCard(page)).toHaveText('Chauffeur-guide', { timeout: 8000 });

  await expect(page.locator('.ch-svc-box')).toHaveCount(2);
  await expect(page.locator('.ch-svc-box[data-action]')).toHaveCount(0);
  await expect(page.locator('button.ch-svc-box')).toHaveCount(0);
  await page.locator('.ch-svc-box', { hasText: 'Point-to-point' }).click({ force: true });
  await page.waitForTimeout(500);
  await expect(activeCard(page)).toHaveText('Chauffeur-guide');
  await expect(page.locator('.ch-req-mismatch')).toHaveCount(0);

  // Changing how it is priced means changing what the customer asked for.
  await askedFor(page, 'chauffeur').click(); // untick
  await askedFor(page, 'private').click();
  await expect(activeCard(page)).toHaveText('Point-to-point', { timeout: 8000 });
});

test('asked for BOTH: priced point-to-point with the chauffeur price alongside, and no mismatch', async ({ page }) => {
  test.slow();
  await openBuilder(page);
  const [d1, d2] = await futureDates(page);
  await setLeg(page, 0, 'Colombo Airport (CMB)', 'Anuradhapura', d1);
  await page.getByText('Add leg').click();
  await page.waitForTimeout(120);
  await setLeg(page, 1, 'Anuradhapura', 'Bentota', d2);
  await askedFor(page, 'chauffeur').click();
  await expect(activeCard(page)).toHaveText('Chauffeur-guide', { timeout: 8000 });
  await askedFor(page, 'private').click(); // now both
  await expect(activeCard(page)).toHaveText('Point-to-point', { timeout: 8000 });
  await expect(page.locator('.ch-svc-box', { hasText: 'Chauffeur-guide' })).toContainText('$299.00');
  await expect(page.locator('.ch-req-mismatch')).toHaveCount(0);
});
