import { test, expect } from '@playwright/test';

// Drives the REAL ops quote view (api/src/routes/ops-ui.html) with a fully stubbed API and
// Google, so it runs on the default offline webServer (serve-booking.js) with NO database.
//
// Regression for design-review D3: "Leg says 'No distance' while the pricing panel prices it."
// A location committed by TYPING + BLUR (native 'change') — not by picking from autocomplete —
// used to leave the leg with distanceKm 0 / autoMatched false, so it showed the amber
// "No distance" pill and a "Check distances" warning while the right rail already priced the
// same typed strings server-side. The generic change handler now schedules auto-distance just
// like acPick(), so a typed leg resolves its km and clears the warning.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page) {
  await page.addInitScript(() => {
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: MapCls,
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
  // est.total.cents, which aborts render() (see ops-quote-route-choice.spec.js). Price by km.
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs ' + (priceCents * 3) },
      amountDueNow: { cents: Math.round(priceCents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'Colombo → Kandy', amountCents: priceCents, lkr: 'Rs 0' }],
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
  await page.route('**/admin/quote/places**', (r) =>
    r.fulfill(json({ places: [], suggestions: [] })));
  // Both endpoints resolve the same typed strings — the distance lookup returns a real km
  // (no route variants → no fork modal).
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
}

async function fillBasics(page) {
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
}

test('a typed-and-blurred leg resolves distance like a pick — no stale "No distance" pill', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await fillBasics(page);

  const from = '.ch-tl-title[data-field="stop"][data-stop="0"]';
  const to = '.ch-tl-title[data-field="stop"][data-stop="1"]';
  await expect(page.locator(from).first()).toBeVisible({ timeout: 10000 });

  // Commit both endpoints by TYPING + native 'change' (blur) — never touching autocomplete.
  await page.locator(from).first().fill('Colombo');
  await page.dispatchEvent(from, 'change');
  await page.locator(to).first().fill('Kandy');
  await page.dispatchEvent(to, 'change');

  // The leg now shows a real km pill (auto-resolved), NOT the amber "No distance" state…
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 5000 });
  await expect(page.locator('.ch-dist-pill.warn')).toHaveCount(0);
  // …and the "Check distances" warning is gone.
  await expect(page.locator('.ch-flag', { hasText: 'Check distances' })).toHaveCount(0);
});

// Clearing a manual km must actually clear it (owner report 2026-07-31). The change handler's
// anti-flicker guard compared the incoming value against `leg[field]`, but since the multi-stop
// refactor the km lives in leg.segments[i].km — so `leg.distanceKm` was always undefined → ''.
// Emptying the box therefore compared '' === '' and returned WITHOUT committing: no re-price,
// and the leg kept quoting its old distance behind a blank field. Every leg on a reopened quote
// renders this manual box, so this was the common way to hit it.
test('clearing a manual km commits the clear and re-prices', async ({ page }) => {
  await stubOps(page);
  // Mirror the real server: a driving leg with no distance cannot be priced (resolveAndPrice
  // 400s), so a committed clear must blank the price rather than leave the old one standing.
  const estimates = [];
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    estimates.push(b);
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    if (!km) {
      return r.fulfill({ status: 400, contentType: 'application/json',
        body: JSON.stringify({ error: "couldn't find the distance for Colombo → Kandy — enter the km manually" }) });
    }
    const priceCents = km * 50;
    return r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      total: { cents: priceCents, lkr: 'Rs 0' },
      lineItems: [{ label: 'Colombo → Kandy', amountCents: priceCents, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: [{ priceCents }] },
      fxUsdToLkr: 320, warnings: [],
    }) });
  });

  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await fillBasics(page);

  const from = '.ch-tl-title[data-field="stop"][data-stop="0"]';
  const to = '.ch-tl-title[data-field="stop"][data-stop="1"]';
  await expect(page.locator(from).first()).toBeVisible({ timeout: 10000 });
  await page.locator(from).first().fill('Colombo');
  await page.dispatchEvent(from, 'change');
  await page.locator(to).first().fill('Kandy');
  await page.dispatchEvent(to, 'change');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 5000 });

  // Take the leg to a manual distance of 200 km.
  await page.locator('[data-action="manualDistance"]').first().click();
  const kmBox = page.locator('[data-field="distanceKm"]').first();
  await expect(kmBox).toBeVisible({ timeout: 5000 });
  await kmBox.fill('200');
  await page.dispatchEvent('[data-field="distanceKm"]', 'change');
  await expect(page.locator('.ch-leg-price').first()).toContainText('$100.00', { timeout: 5000 });

  // Now empty the box, exactly as an operator re-doing a distance would.
  estimates.length = 0;
  await kmBox.fill('');
  await page.dispatchEvent('[data-field="distanceKm"]', 'change');

  // The clear must reach state: a re-price fires, and it carries no distance for the leg.
  await expect.poll(() => estimates.length, { timeout: 5000 }).toBeGreaterThan(0);
  expect(estimates.at(-1).legs[0].distanceKm).toBe(0);
  // …and the leg must not still be quoting the distance the operator just deleted.
  await expect(page.locator('.ch-leg-price').first()).not.toContainText('$100.00', { timeout: 5000 });
});

test('the "Check distances" warning does not fire on a leg with no locations yet (D4)', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await fillBasics(page);

  // Trip basics are filled but the single leg has NO pickup/dropoff — the warning must not
  // claim the leg "couldn't be auto-located"; that reads as a failure before any input.
  await expect(page.locator('.ch-tl-title[data-field="stop"][data-stop="0"]').first()).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ch-flag', { hasText: 'Check distances' })).toHaveCount(0);
});
