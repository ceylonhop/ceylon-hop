import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Fees as inline toggle chips (2026-08-01): the sightseeing/waiting/safari-wait fees are
// toggle chips ON the leg tools row — one click, price visible at the point of decision.
// The old "+ Fees" popover (toggleAddons + a checkbox tray band) is gone; these specs pin
// the replacement. Drives the real ops quote view with a stubbed API (no DB) on the
// offline webServer — stub recipe cloned from ops-chauffeur-date.spec.js.
//
// E2E lessons applied (see ops-trip-calendar.spec.js): every interaction is act-then-verify
// in an expect().toPass() loop with an idempotence guard (the builder re-renders ~350ms
// after each mutation and can swallow a click mid-morph), assertions read attributes/classes
// (state truth), and the file opts out of fullyParallel.

test.describe.configure({ mode: 'default' });

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
  await routeOpsEstimate(page); // see _ops-estimate.js — an empty estimate throws inside render()
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  // Rate card WITH extras — the chips read their display prices from here.
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
    extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 373, durationMin: 436 })));
}

async function bootBuilder(page) {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg').first()).toBeVisible({ timeout: 10000 });
}

test('fee chips render on a point-to-point leg with rate-card prices; the tray is gone', async ({ page }) => {
  await bootBuilder(page);

  // Three chips on the (single) leg, in the tools row.
  const chips = page.locator('[data-action="toggleFee"]');
  await expect(chips).toHaveCount(3);
  await expect(chips.nth(0)).toHaveAttribute('data-fee-field', 'addSightseeingFee');
  await expect(chips.nth(1)).toHaveAttribute('data-fee-field', 'addWaitingFee');
  await expect(chips.nth(2)).toHaveAttribute('data-fee-field', 'addSafariWait');

  // Price at the point of decision, read from the stubbed rate card.
  await expect(chips.nth(0)).toContainText('Sightseeing');
  await expect(chips.nth(0)).toContainText('$10');
  await expect(chips.nth(2)).toContainText('Safari wait');
  await expect(chips.nth(2)).toContainText('$19');

  // The popover control and the checkbox tray no longer exist.
  await expect(page.locator('[data-action="toggleAddons"]')).toHaveCount(0);
  await expect(page.locator('input[data-field="addSightseeingFee"]')).toHaveCount(0);
  await expect(page.locator('.ch-leg-addons')).toHaveCount(0);
});

test('clicking a fee chip toggles it on and off, and an active fee keeps the tools row legible at rest', async ({ page }) => {
  await bootBuilder(page);

  const waiting = () => page.locator('[data-action="toggleFee"][data-fee-field="addWaitingFee"]').first();
  await expect(waiting()).toHaveAttribute('aria-pressed', 'false');

  // ON — act-then-verify with an idempotence guard (a mid-morph click can be swallowed;
  // an extra click on an already-on chip would silently toggle it back off).
  await expect(async () => {
    if ((await waiting().getAttribute('aria-pressed')) !== 'true') {
      await waiting().dispatchEvent('click');
    }
    await expect(waiting()).toHaveAttribute('aria-pressed', 'true');
  }).toPass({ timeout: 10000 });
  await expect(waiting()).toHaveClass(/\bon\b/);

  // A fee is money on the leg — a state readout, not an action — so the tools row must NOT
  // carry the fade-at-rest class while one is active.
  await expect(page.locator('.ch-leg').first().locator('.ch-leg-tools')).not.toHaveClass(/is-actions-only/);

  // OFF again, same guard in the other direction.
  await expect(async () => {
    if ((await waiting().getAttribute('aria-pressed')) !== 'false') {
      await waiting().dispatchEvent('click');
    }
    await expect(waiting()).toHaveAttribute('aria-pressed', 'false');
  }).toPass({ timeout: 10000 });
  await expect(waiting()).not.toHaveClass(/\bon\b/);
  await expect(page.locator('.ch-leg').first().locator('.ch-leg-tools')).toHaveClass(/is-actions-only/);
});
