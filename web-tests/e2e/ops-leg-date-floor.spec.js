import { test, expect } from '@playwright/test';

// Owner report 2026-07-26: "when you add a new leg and add the date, the calendar should default
// to the correct month, so users don't click through to the correct month for every leg."
//
// A native <input type="date"> with an EMPTY value opens its calendar on `min`'s month when min is
// in the future (otherwise today's). Every leg's min used to be a flat "today", so on a trip three
// months out the operator paged forward for every leg they added. min now chains off the nearest
// dated leg above — which also stops a later leg being dated before an earlier one, previously
// only a warning in the flags card.
//
// The native popup is browser chrome, not DOM, so what is asserted here is the `min` contract that
// drives it. Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const iso = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const inDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };

async function stubOps(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({ product: 'private', total: { cents: 12100, lkr: 'x' }, lineItems: [], breakdown: { km: {}, legs: [] }, services: { pointToPoint: { total: { cents: 12100 } }, chauffeur: { error: 'x' } }, warnings: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/quote/places**', (r) => { const q = new URL(r.request().url()).searchParams.get('q') || ''; r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] })); });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
}

async function openBuilder(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await expect(page.locator('.ch-leg-date input[type="date"]').first()).toBeVisible({ timeout: 10000 });
}

const dateInputs = (page) => page.locator('.ch-leg-date input[type="date"]');

async function setLegDate(page, i, value) {
  const input = dateInputs(page).nth(i);
  await input.fill(value);
  await input.dispatchEvent('change');
}

test('a new leg opens its calendar on the month of the leg above, not today', async ({ page }) => {
  await stubOps(page);
  await openBuilder(page);

  // Leg 1 has no leg above it, so its floor is today.
  await expect(dateInputs(page).first()).toHaveAttribute('min', inDays(0));

  // Date leg 1 well into the future, then add a leg.
  const start = inDays(60);
  await setLegDate(page, 0, start);
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(2, { timeout: 10000 });

  // Leg 2's calendar now opens on leg 1's month rather than the current one.
  await expect(dateInputs(page).nth(1)).toHaveAttribute('min', start);
  await expect(dateInputs(page).nth(1)).toHaveValue(''); // still blank — no guessed date
});

test('the floor chains forward across several legs', async ({ page }) => {
  await stubOps(page);
  await openBuilder(page);

  const d1 = inDays(60), d2 = inDays(64);
  await setLegDate(page, 0, d1);
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(2, { timeout: 10000 });
  await setLegDate(page, 1, d2);
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(3, { timeout: 10000 });

  // Leg 3 follows leg 2, not leg 1.
  await expect(dateInputs(page).nth(2)).toHaveAttribute('min', d2);
});

test('an undated leg in the middle does not reset the floor to today', async ({ page }) => {
  await stubOps(page);
  await openBuilder(page);

  const d1 = inDays(60);
  await setLegDate(page, 0, d1);
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(2, { timeout: 10000 });
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(3, { timeout: 10000 });

  // Leg 2 is left blank; leg 3 must still look back past it to leg 1 rather than to today.
  await expect(dateInputs(page).nth(1)).toHaveValue('');
  await expect(dateInputs(page).nth(2)).toHaveAttribute('min', d1);
});

test('a date typed before the leg above it is rejected with a reason that names the rule', async ({ page }) => {
  await stubOps(page);
  await openBuilder(page);

  const d1 = inDays(60);
  await setLegDate(page, 0, d1);
  await page.getByText('Add leg').click();
  await expect(dateInputs(page)).toHaveCount(2, { timeout: 10000 });

  // A future date, but earlier than leg 1 — the old guard only caught dates before TODAY.
  await setLegDate(page, 1, inDays(30));
  await expect(dateInputs(page).nth(1)).toHaveValue('');
  await expect(page.locator('.ch-toast, [class*="toast"]').first())
    .toContainText('before the leg above', { timeout: 5000 });
});

test('a past date is still rejected with the past-date message on the first leg', async ({ page }) => {
  await stubOps(page);
  await openBuilder(page);

  await setLegDate(page, 0, inDays(-5));
  await expect(dateInputs(page).first()).toHaveValue('');
  await expect(page.locator('.ch-toast, [class*="toast"]').first())
    .toContainText('past', { timeout: 5000 });
});
