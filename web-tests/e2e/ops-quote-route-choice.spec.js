import { test, expect } from '@playwright/test';

// Route-choice "Compare routes" button (plan 2026-07-20, Task 3). Drives the REAL ops quote
// view offline — stubbed API + Google, same harness as ops-autocomplete.spec.js — so it runs
// on the default webServer with no database. Server-side pricing/persistence of the fields is
// covered by api/src/routes/internalQuote.test.ts (Task 2); here we assert the UI contracts:
// pills, apply, resets, and that the estimate payload carries routeVariant/routeOptions.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const VARIANTS = { fastest: { km: 292, durationMin: 330 }, noTolls: { km: 205, durationMin: 390 } };

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
  // A valid-shaped estimate is REQUIRED: an empty {} makes the money-card renderer throw on
  // est.total.cents, which aborts render() before input listeners re-attach — every later
  // interaction then hits dead DOM (found the hard way; see PR 3).
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({
    total: { cents: 9800, lkr: 'Rs 31,360' },
    amountDueNow: { cents: 980, lkr: 'Rs 3,136' },
    lineItems: [{ label: 'Colombo City → Ella', amountCents: 9800, lkr: 'Rs 31,360' }],
    breakdown: { km: { distanceKm: 292, bufferKm: 29, billableKm: 321 } },
    fxUsdToLkr: 320,
    warnings: [],
    services: {
      pointToPoint: { total: { cents: 9800, lkr: 'Rs 31,360' } },
      chauffeur: { error: 'single-day trip — point-to-point only' },
    },
  })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  // Echo the typed query back as a pickable suggestion — commits go through the acPick path,
  // matching how ops actually use the tool. (Typing + Tab without picking hits a pre-existing
  // auto-distance bug on main — change-handler races the blur handler; tracked separately.)
  await page.route('**/admin/quote/places**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') || '';
    r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
  });
  // Distance stub understands compare mode: Colombo City → Ella is the choice pair,
  // everything else compares to "same route"; the non-compare path returns one distance.
  await page.route('**/admin/quote/distance', (r) => {
    const b = r.request().postDataJSON() || {};
    if (b.compare) {
      if (b.from === 'Colombo City' && b.to === 'Ella') {
        return r.fulfill(json({ km: 292, durationMin: 330, hasChoice: true, variants: VARIANTS }));
      }
      return r.fulfill(json({ km: 120, durationMin: 180, hasChoice: false }));
    }
    return r.fulfill(json(b.to === 'Ella' ? { km: 292, durationMin: 330 } : { km: 120, durationMin: 180 }));
  });
}

async function bootQuote(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
}

async function pickPlace(page, field, name) {
  // Commit via the autocomplete pick (acPick) — the path real ops take, and the one that
  // reliably schedules auto-distance. The places stub echoes the typed text back as the
  // single suggestion.
  const input = page.locator('.ch-tl-title[data-field="' + field + '"]').first();
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
}

async function setLegRoute(page, from, to) {
  await pickPlace(page, 'pickupLocation', from);
  await pickPlace(page, 'dropoffLocation', to);
}

test('compare shows the two-pill picker for a choice pair, expressway active by default', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('292 km', { timeout: 10000 });

  await page.locator('[data-action="compareRoutes"]').first().click();
  const fastPill = page.locator('[data-action="routeFastest"]').first();
  const slowPill = page.locator('[data-action="routeNoTolls"]').first();
  await expect(fastPill).toBeVisible({ timeout: 5000 });
  await expect(fastPill).toContainText('Expressway');
  await expect(fastPill).toContainText('292 km');
  await expect(fastPill).toHaveClass(/is-active/);
  await expect(slowPill).toContainText('Local road');
  await expect(slowPill).toContainText('205 km');
  await expect(slowPill).not.toHaveClass(/is-active/);
});

test('picking Local road applies km + hours, payload carries the fields, long-drive flag fires', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('292 km', { timeout: 10000 });
  await page.locator('[data-action="compareRoutes"]').first().click();
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toBeVisible({ timeout: 5000 });

  const estimateReq = page.waitForRequest(
    (req) => req.url().includes('/admin/quote/estimate')
      && (req.postDataJSON()?.legs || []).some((l) => l.routeVariant === 'no_tolls'),
    { timeout: 10000 },
  );
  await page.locator('[data-action="routeNoTolls"]').first().click();

  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('205 km');
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toHaveClass(/is-active/);
  const leg = (await estimateReq).postDataJSON().legs.find((l) => l.routeVariant === 'no_tolls');
  expect(leg.distanceKm).toBe(205);
  expect(leg.routeOptions).toEqual(VARIANTS);
  // 6.5 h local road crosses the existing ≥6h threshold — expected side effect, not a bug.
  await expect(page.getByText('Long drive warning')).toBeVisible({ timeout: 5000 });
});

test('a no-choice pair reports "same route" and renders no pills', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Kandy');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 10000 });
  await page.locator('[data-action="compareRoutes"]').first().click();
  await expect(page.locator('.ch-route-same').first()).toContainText('Same route', { timeout: 5000 });
  await expect(page.locator('.ch-route-pill')).toHaveCount(0);
});

test('editing a location clears the picked route — no stale "via local road" survives', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('292 km', { timeout: 10000 });
  await page.locator('[data-action="compareRoutes"]').first().click();
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toBeVisible({ timeout: 5000 });
  await page.locator('[data-action="routeNoTolls"]').first().click();
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toHaveClass(/is-active/);

  // Change the pickup — the commit path (acPick) must drop pills, variant, and options.
  const cleanEstimate = page.waitForRequest(
    (req) => req.url().includes('/admin/quote/estimate')
      && (req.postDataJSON()?.legs || []).every((l) => l.routeVariant === undefined),
    { timeout: 10000 },
  );
  await pickPlace(page, 'pickupLocation', 'Negombo');
  await expect(page.locator('.ch-route-pill')).toHaveCount(0, { timeout: 5000 });
  await cleanEstimate;
});

test('the manual-km pencil clears the active variant (typed km is not a Google route)', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('292 km', { timeout: 10000 });
  await page.locator('[data-action="compareRoutes"]').first().click();
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toBeVisible({ timeout: 5000 });
  await page.locator('[data-action="routeNoTolls"]').first().click();
  await expect(page.locator('[data-action="routeNoTolls"]').first()).toHaveClass(/is-active/);

  await page.locator('[data-action="manualDistance"]').first().click();
  await expect(page.locator('.ch-dist-manual input[data-field="distanceKm"]').first()).toBeVisible();
  await expect(page.locator('.ch-route-pill.is-active')).toHaveCount(0);
});
