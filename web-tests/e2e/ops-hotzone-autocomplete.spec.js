import { test, expect } from '@playwright/test';

// Drives the REAL ops quote view (api/src/routes/ops-ui.html) with a fully stubbed API +
// Google, on the default offline webServer (no DB), like ops-autocomplete.spec.js.
//
// Covers the Rate-Settings "Hot zones" town field (#hz-place): it must offer the SAME Google/
// known-places autocomplete the quote tool uses, so a founder PICKS a canonical place label
// instead of free-typing (which let towns like "Passikudah" silently never match). Only the
// picker is asserted here — matching/pricing is covered in api/src/routes/hotZonesRoutes.test.ts.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page, places) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}),
      },
    };
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  // Founder needs margin:view for the Rates button AND the Hot-zones panel to render.
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'margin:view'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/zones', (r) => r.fulfill(json({ zones: [], disabled: false })));
  // Rate card stays null → the modal shows its "Loading rate card…" placeholder (the real card
  // shape is irrelevant here; the Hot-zones panel renders independently). Keeps this test robust
  // to rate-card schema changes.
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill({ status: 500, body: '' }));
  await page.route('**/admin/quote/places**', (r) =>
    r.fulfill(json({ places, suggestions: places.map((label) => ({ label, source: 'known' })) })));
}

async function openHotZones(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="openRates"]').first().click();
  await expect(page.locator('#hz-place')).toBeVisible({ timeout: 10000 });
}

test('hot-zone town field suggests places and picks the canonical label', async ({ page }) => {
  await stubOps(page, ['Batticaloa']);
  await openHotZones(page);

  const place = page.locator('#hz-place');
  await place.click();
  await page.keyboard.type('Batti', { delay: 40 });

  const menu = page.locator('.ch-ac-menu').first();
  await expect(menu).toBeVisible({ timeout: 5000 });
  await menu.locator('.ch-ac-item', { hasText: 'Batticaloa' }).first().click();

  // Picking writes the canonical label and closes the dropdown.
  await expect(place).toHaveValue('Batticaloa');
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);
});

test('hot-zone picker dismisses on Escape and short queries do not open it', async ({ page }) => {
  await stubOps(page, ['Mannar']);
  await openHotZones(page);

  const place = page.locator('#hz-place');
  await place.click();

  // < 2 chars: no menu.
  await page.keyboard.type('M', { delay: 40 });
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);

  // Enough chars: menu opens, Escape closes it.
  await page.keyboard.type('annar', { delay: 40 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);
});
