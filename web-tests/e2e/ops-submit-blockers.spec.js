import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: "when a user is trying to submit a quote for review and there is not
// enough data, tell the user what's missing." The only gate used to be requestedService, shown
// as a DISABLED button with a hover title — indistinguishable from a broken button — while a
// quote with no contact, no price or unresolved distances submitted happily. Submit is now
// always pressable and opens a panel naming every missing thing.
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

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
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'ops@e2e.test', role: 'ops', caps: ['quote:manage'] })));
  await page.route('**/admin/quote/places**', (r) => {
    const q = new URL(r.request().url()).searchParams.get('q') || '';
    r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] }));
  });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const driving = (b.legs || []).filter((l) => l.category !== 'stay_day');
    if (driving.some((l) => !(l.distanceKm > 0))) return r.fulfill(json({ error: 'unknown distance' }));
    const total = 12100;
    return r.fulfill(json({
      total: { cents: total, lkr: 'Rs 1' }, amountDueNow: { cents: 0, lkr: 'Rs 0' },
      lineItems: [{ label: 'Private transfer', amountCents: total, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: 120, bufferKm: 0, billableKm: 120 }, legs: [{ priceCents: total }] },
      fxUsdToLkr: 320, warnings: [],
      services: { pointToPoint: { total: { cents: total, lkr: 'Rs 0' } }, chauffeur: { error: 'single-day trip' } },
    }));
  });
}

async function pickPlace(page, legIndex, stop, name) {
  const input = page.locator('.ch-leg').nth(legIndex)
    .locator('.ch-tl-title[data-field="stop"][data-stop="' + stop + '"]');
  await expect(input).toBeVisible({ timeout: 10000 });
  await input.click();
  await input.fill('');
  await page.keyboard.type(name, { delay: 10 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: name }).first().click();
}

const submitBtn = (page) => page.locator('[data-action="submitForReview"]');
const panel = (page) => page.locator('.ch-blockers');

test('Submit for review is pressable on an empty quote and names everything missing', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // The button must NOT be disabled — pressing it is how you learn what's wrong.
  await expect(submitBtn(page)).toBeEnabled();
  await expect(panel(page)).toHaveCount(0); // silent until asked

  await submitBtn(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(panel(page)).toContainText('Not ready to submit');

  // Every absence on a blank quote is named, not just the one that used to gate the button.
  const rows = page.locator('.ch-blocker-row');
  await expect(rows.filter({ hasText: 'first name' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'contact the customer' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'What the customer asked for' })).toHaveCount(1);
  await expect(rows.filter({ hasText: 'A vehicle' })).toHaveCount(1);
  await expect(rows.filter({ hasText: /distance/i })).toHaveCount(1);

  // And nothing was submitted.
  await expect(page.locator('.ch-status-pill')).toContainText('Draft');
});

test('clicking a blocker row jumps to the field it names', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await submitBtn(page).click();

  await page.locator('.ch-blocker-row', { hasText: 'first name' }).click();
  await expect(page.locator('#f-firstName')).toBeFocused();
  // The panel stays open — fixing one blocker rarely fixes them all.
  await expect(panel(page)).toBeVisible();
});

test('the panel clears as fields are filled, and submit goes through once nothing is missing', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  await page.locator('#f-firstName').fill('Karen');
  await page.locator('#f-firstName').blur();
  await page.locator('#f-contact').fill('+94 77 123 4567');
  await page.locator('#f-contact').blur();
  await page.locator('[data-action="setRequestedService"][data-req="private"]').click();
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await pickPlace(page, 0, 0, 'Colombo');
  await pickPlace(page, 0, 1, 'Kandy');
  // Wait for the leg to actually price before submitting.
  await expect(page.locator('.ch-leg-price').first()).toHaveText(/^\$\d/, { timeout: 10000 });

  let patched = null;
  await page.route(/\/admin\/quote\/[^/]+$/, (r) => {
    if (r.request().method() === 'PATCH') { patched = r.request().postDataJSON(); return r.fulfill(json({ status: 'pending_review' })); }
    return r.fulfill(json({}));
  });
  await page.route('**/admin/quote/save', (r) => r.fulfill(json({ id: 'new1', reference: 'Q-NEW1', status: 'draft' })));

  await submitBtn(page).click();
  await expect.poll(() => patched, { timeout: 10000 }).not.toBeNull();
  expect(patched.status).toBe('pending_review');
  await expect(panel(page)).toHaveCount(0);
});

test('a missing contact alone blocks submission and the label says it is required', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  await page.locator('#f-firstName').fill('Karen');
  await page.locator('#f-firstName').blur();
  await page.locator('[data-action="setRequestedService"][data-req="private"]').click();
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await pickPlace(page, 0, 0, 'Colombo');
  await pickPlace(page, 0, 1, 'Kandy');
  await expect(page.locator('.ch-leg-price').first()).toHaveText(/^\$\d/, { timeout: 10000 });

  await submitBtn(page).click();
  await expect(panel(page)).toBeVisible();
  await expect(page.locator('.ch-blocker-row')).toHaveCount(1);
  await expect(page.locator('.ch-blocker-row')).toContainText('contact the customer');
  // The field's own label must agree with the gate rather than still saying "optional".
  await expect(page.locator('#f-contact').locator('xpath=ancestor::div[contains(@class,"ch-field")]')).not.toContainText('optional');
});
