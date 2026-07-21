import { test, expect } from '@playwright/test';

// Route-choice MODAL (plan 2026-07-21). Drives the REAL ops quote view offline — stubbed API +
// Google, same harness as ops-autocomplete.spec.js — so it runs on the default webServer with no
// database. Server-side pricing/persistence of the fields is covered by
// api/src/routes/internalQuote.test.ts; here we assert the UI contracts: a fork leg auto-opens
// the modal, picking applies km + note, dismiss keeps the default and does not re-pop, a no-fork
// leg stays quiet, the chip reopens the modal, and the estimate payload carries the fields.

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
  // Prices by km so each route variant prices differently: 50¢/km, and breakdown.legs carries
  // the per-leg priceCents the modal reads back (the real engine returns this too).
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs ' + (priceCents * 3) },
      amountDueNow: { cents: Math.round(priceCents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'Colombo City → Ella', amountCents: priceCents, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: [{ priceCents }] },
      fxUsdToLkr: 320,
      warnings: [],
      services: {
        pointToPoint: { total: { cents: priceCents, lkr: 'Rs 0' } },
        chauffeur: { error: 'single-day trip — point-to-point only' },
      },
    }));
  });
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

test('a fork leg auto-opens the modal with both option cards (and no inline pills)', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');

  const modal = page.locator('.ch-rc-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  await expect(modal.locator('.ch-rc-card[data-route="fastest"]')).toContainText('Expressway');
  await expect(modal.locator('.ch-rc-card[data-route="fastest"]')).toContainText('292 km');
  await expect(modal.locator('.ch-rc-card[data-route="local"]')).toContainText('Local road');
  await expect(modal.locator('.ch-rc-card[data-route="local"]')).toContainText('205 km');
  // The Phase-1 inline pills are gone.
  await expect(page.locator('.ch-route-pill')).toHaveCount(0);
});

test('each option shows its engine-priced fare, and local road shows the saving', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  const modal = page.locator('.ch-rc-modal');
  await expect(modal).toBeVisible({ timeout: 10000 });
  // Expressway 292 km × 50¢ = $146.00; local 205 km × 50¢ = $102.50; saves $43.50 — real prices
  // from the estimate engine (this leg's km overridden per variant), not a client-side formula.
  await expect(modal.locator('.ch-rc-card[data-route="fastest"]')).toContainText('$146.00', { timeout: 10000 });
  await expect(modal.locator('.ch-rc-card[data-route="local"]')).toContainText('$102.50');
  await expect(modal.locator('.ch-rc-card[data-route="local"]')).toContainText('saves $43.50');
});

test('picking Local road applies km + note; payload carries the fields; chip reflects the pick', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-rc-modal')).toBeVisible({ timeout: 10000 });

  const estimateReq = page.waitForRequest(
    (req) => req.url().includes('/admin/quote/estimate')
      && (req.postDataJSON()?.legs || []).some((l) => l.routeVariant === 'no_tolls'),
    { timeout: 10000 },
  );
  await page.locator('.ch-rc-card[data-route="local"]').click();       // select
  await page.locator('[data-action="routeModalPickLocal"]').click();   // Use local road

  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('205 km');
  await expect(page.locator('.ch-route-chip').first()).toContainText('Local road');
  // The customer note "(via local road, no highway tolls)" is gated behind "Ready to send" in a
  // draft, so it isn't visible here — its exact copy is pinned by web-tests/unit/ops-route-note.test.js.

  const leg = (await estimateReq).postDataJSON().legs.find((l) => l.routeVariant === 'no_tolls');
  expect(leg.distanceKm).toBe(205);
  expect(leg.routeOptions).toEqual(VARIANTS);
});

test('dismiss keeps the default (no note) and does not re-pop on a re-render', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-rc-modal')).toBeVisible({ timeout: 10000 });

  await page.getByRole('button', { name: 'Keep expressway, decide later' }).click();
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
  // No pick → undecided chip offers "Compare routes".
  await expect(page.locator('.ch-route-chip').first()).toContainText('Compare routes');

  // A re-render (edit the leg date) must NOT re-pop the modal.
  const dateInput = page.locator('#quoteRoot input[type="date"]').first();
  if (await dateInput.count()) {
    await dateInput.fill('2026-12-31');
    await dateInput.dispatchEvent('change');
  }
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
});

test('a no-choice pair shows "same route" and never opens the modal', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Kandy');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 10000 });
  await expect(page.locator('.ch-route-same').first()).toContainText('Same route', { timeout: 5000 });
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
});

test('the chip reopens the modal after a dismiss', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-rc-modal')).toBeVisible({ timeout: 10000 });
  await page.getByRole('button', { name: 'Keep expressway, decide later' }).click();
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);

  await page.locator('.ch-route-chip').first().click();
  await expect(page.locator('.ch-rc-modal')).toBeVisible({ timeout: 5000 });
});

test('editing a location after a pick clears the picked route — no stale note survives', async ({ page }) => {
  await stubOps(page);
  await bootQuote(page);
  await setLegRoute(page, 'Colombo City', 'Ella');
  await expect(page.locator('.ch-rc-modal')).toBeVisible({ timeout: 10000 });
  await page.locator('.ch-rc-card[data-route="local"]').click();
  await page.locator('[data-action="routeModalPickLocal"]').click();
  await expect(page.locator('.ch-route-chip').first()).toContainText('Local road');

  const cleanEstimate = page.waitForRequest(
    (req) => req.url().includes('/admin/quote/estimate')
      && (req.postDataJSON()?.legs || []).every((l) => l.routeVariant === undefined),
    { timeout: 10000 },
  );
  await pickPlace(page, 'pickupLocation', 'Negombo');   // new pair Negombo → Ella has no fork
  await cleanEstimate;
  // The picked route is gone: no "Route: Local road" chip survives the location change.
  await expect(page.getByText('Route: Local road')).toHaveCount(0, { timeout: 5000 });
});
