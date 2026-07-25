import { test, expect } from '@playwright/test';

// Multi-stop rides (Phase 2). Drives the REAL ops quote view offline — stubbed API + Google,
// same harness as ops-quote-route-choice.spec.js — so it runs on the default webServer with no
// database. Server-side schema/persistence of stops+segmentKms is covered by
// api/src/routes/internalQuote.test.ts; here we assert the browser-only UI mechanics that no
// API test can reach: "+ stop" building a 3-stop ride, the estimate wire carrying the stop
// chain, "and return" appending the start, and the duplicate-consecutive-stop surfacing.

const OPS_FILE = '/api/src/routes/ops-ui.html';

// Straight-line road km for each ordered pair the specs use (the stub is direction-agnostic).
const PAIR_KM = {
  'Kandy|Dambulla': 72, 'Dambulla|Ella': 95,
  'Habarana|Polonnaruwa': 47, 'Polonnaruwa|Habarana': 47,
  'Kandy|Ella': 140,
};

function stubOps(page, capture) {
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

  return Promise.all([
    page.addInitScript(() => {
      function Noop() {}
      Noop.prototype.route = function (req, cb) { cb({ routes: [{ legs: [{ distance: { value: 100000 }, duration: { value: 6000 } }] }] }, 'OK'); };
      Noop.prototype.setMap = function () {}; Noop.prototype.setDirections = function () {};
      window.google = {
        accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
        maps: {
          Map: Noop, DirectionsService: Noop, DirectionsRenderer: Noop,
          TravelMode: { DRIVING: 'DRIVING' },
          places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
          importLibrary: async () => ({}),
        },
      };
    }),
    // Catch-all FIRST so the specific handlers below (registered later) take priority — Playwright
    // runs the most-recently-registered matching route first.
    page.route('**/admin/**', (r) => r.fulfill(json({}))),
    page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] }))),
    page.route('**/admin/ops/bookings', (r) => r.fulfill(json([]))),
    // Echo the typed query back as the single pickable suggestion (the acPick path real ops take).
    page.route('**/admin/quote/places**', (r) => {
      const q = new URL(r.request().url()).searchParams.get('q') || '';
      r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
    }),
    page.route('**/admin/quote/distance', (r) => {
      const b = r.request().postDataJSON() || {};
      const km = PAIR_KM[`${b.from}|${b.to}`] ?? 60;
      if (b.compare) return r.fulfill(json({ km, durationMin: km, hasChoice: false }));
      return r.fulfill(json({ km, durationMin: km }));
    }),
    // Capture each estimate payload, then return a valid-shaped response (an empty {} makes the
    // money-card renderer throw and abort the render, killing later interactions).
    page.route('**/admin/quote/estimate', (r) => {
      capture.last = r.request().postDataJSON();
      r.fulfill(json({
        total: { cents: 9800, lkr: 'Rs 31,360' },
        amountDueNow: { cents: 9800, lkr: 'Rs 31,360' },
        lineItems: [{ label: 'Ride', amountCents: 9800, lkr: 'Rs 31,360' }],
        breakdown: { km: { distanceKm: 100, bufferKm: 10, billableKm: 110 } },
        fxUsdToLkr: 320, warnings: [],
        services: { pointToPoint: { total: { cents: 9800, lkr: 'Rs 31,360' } }, chauffeur: { error: 'single-day trip — point-to-point only' } },
      }));
    }),
  ]);
}

async function bootQuote(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-tl-title[data-field="stop"][data-stop="0"]').first()).toBeVisible({ timeout: 10000 });
}

// Commit a place into a specific stop input via the autocomplete pick (acPick).
async function pickStop(page, stopIdx, name) {
  const input = page.locator(`.ch-leg`).first().locator(`.ch-tl-title[data-field="stop"][data-stop="${stopIdx}"]`);
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
  await page.waitForTimeout(120);
}

async function addStop(page) {
  await page.locator('[data-action="addStop"]').first().click();
  await page.waitForTimeout(120);
}

test('a 3-stop ride sends one leg with the full stop chain + per-segment kms', async ({ page }) => {
  test.slow();
  const capture = {};
  await stubOps(page, capture);
  await bootQuote(page);

  await pickStop(page, 0, 'Kandy');
  await pickStop(page, 1, 'Ella');
  await addStop(page);                 // ['Kandy','','Ella'] — new blank BEFORE the last stop
  await pickStop(page, 1, 'Dambulla'); // ['Kandy','Dambulla','Ella']

  // Three stop inputs now render, indexed 0..2.
  await expect(page.locator('.ch-leg').first().locator('.ch-tl-title[data-field="stop"]')).toHaveCount(3);

  // The estimate wire carries ONE leg with the ordered stop chain and 2 segment kms.
  await expect.poll(() => capture.last?.legs?.[0]?.stops?.join('>'), { timeout: 8000 })
    .toBe('Kandy>Dambulla>Ella');
  expect(capture.last.legs[0].segmentKms).toHaveLength(2);
  expect(capture.last.legs).toHaveLength(1); // never split into pairwise legs
});

test('"and return" appends the start as a final stop (out-and-back)', async ({ page }) => {
  test.slow();
  const capture = {};
  await stubOps(page, capture);
  await bootQuote(page);

  await pickStop(page, 0, 'Habarana');
  await pickStop(page, 1, 'Polonnaruwa');
  await page.locator('[data-action="andReturn"]').first().click();
  await page.waitForTimeout(150);

  await expect(page.locator('.ch-leg').first().locator('.ch-tl-title[data-field="stop"]')).toHaveCount(3);
  await expect.poll(() => capture.last?.legs?.[0]?.stops?.join('>'), { timeout: 8000 })
    .toBe('Habarana>Polonnaruwa>Habarana');
});

test('two consecutive identical stops surface a duplicate warning, not a silent legacy price', async ({ page }) => {
  test.slow();
  const capture = {};
  await stubOps(page, capture);
  await bootQuote(page);

  await pickStop(page, 0, 'Kandy');
  await pickStop(page, 1, 'Ella');
  await addStop(page);
  await pickStop(page, 1, 'Ella');     // ['Kandy','Ella','Ella'] — consecutive duplicate

  // Surfaced to the operator via the business-flags card (shows regardless of pricing state).
  await expect(page.getByText(/Duplicate consecutive stops/i).first())
    .toBeVisible({ timeout: 8000 });

  // ...and NOT silently sent as a valid multi-stop chain: the duplicate pair drops the leg to
  // the legacy from/to mirror, so no `stops` array rides the wire (the surfacing is what keeps
  // that fallback from being silent).
  await expect.poll(() => capture.last?.legs?.[0]?.stops ?? null, { timeout: 8000 }).toBeNull();
});
