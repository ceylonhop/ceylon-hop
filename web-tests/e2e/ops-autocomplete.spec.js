import { test, expect } from '@playwright/test';

// Drives the REAL ops quote view (api/src/routes/ops-ui.html) with a fully stubbed API and
// Google, so it runs on the default offline webServer (serve-booking.js) with NO database —
// unlike quote-tool.spec.js, which needs CH_E2E_API=1 + a real DATABASE_URL.
//
// Regression for: "in the ops tool, even after I choose an item from autocomplete, the
// dropdown pops out multiple times." Root cause: acPick() set _ac.committed=true but then
// acClose() cleared it before render(); restoreEditorFocus() (runs on every render and
// refocuses the picked field) had no committed guard, so it re-fired requestAutocomplete()
// for the committed value once per follow-up auto-distance/estimate render.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page) {
  // Google (Maps + Sign-In) stubbed so boot and any client google use is inert.
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

  // Catch-all FIRST (Playwright uses the last-registered matching route), then specifics.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/places**', (r) =>
    r.fulfill(json({ places: ['Kandy'], suggestions: [{ label: 'Kandy', source: 'known' }] })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
}

test('ops quote autocomplete stays closed after picking a place', async ({ page }) => {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote'); // #quote → bootApp mounts the quote view immediately
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  // The itinerary is gated until the trip basics are filled — set vehicle + name + contact.
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await expect(fromInput).toBeVisible({ timeout: 10000 });

  await fromInput.click();
  await page.keyboard.type('Kand', { delay: 40 });
  await expect(page.locator('.ch-ac-menu').first()).toBeVisible({ timeout: 5000 });
  await page.locator('.ch-ac-menu .ch-ac-item', { hasText: 'Kandy' }).first().click();

  // The dropdown closes on pick…
  await expect(fromInput).toHaveValue('Kandy');
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);

  // …and STAYS closed while follow-up auto-distance / estimate re-renders land (each of
  // which refocuses this field). Before the fix it reopened once per re-render.
  await page.waitForTimeout(900);
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0);
});

// Regression for: "when I attempt to scroll the autocomplete results the whole site
// scrolls and the autocomplete results go away." The menu is its own scroll box
// (max-height + overflow-y), but the global close-on-wheel listener fired for wheel
// events INSIDE the menu too, so the first wheel tick dismissed it.
test('wheeling inside the autocomplete scrolls the list; outside still dismisses it', async ({ page }) => {
  await stubOps(page);
  // Enough results to overflow the menu's 264px max-height so it actually scrolls.
  const many = Array.from({ length: 12 }, (_, i) => `Kandy Result ${i + 1}`);
  await page.route('**/admin/quote/places**', (r) => r.fulfill({
    status: 200, contentType: 'application/json',
    body: JSON.stringify({ places: many, suggestions: many.map((label) => ({ label, source: 'known' })) }),
  }));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-lastName', 'Customer');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  const fromInput = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  await expect(fromInput).toBeVisible({ timeout: 10000 });
  await fromInput.click();
  await page.keyboard.type('Kand', { delay: 40 });
  const menu = page.locator('.ch-ac-menu').first();
  await expect(menu).toBeVisible({ timeout: 5000 });
  // Let the menu settle: the async Google merge re-renders it (fresh element, scrollTop 0),
  // so wheel only after the loading row is gone or the wheel hits a soon-replaced element.
  await expect(page.locator('.ch-ac-item.loading')).toHaveCount(0, { timeout: 5000 });
  await page.waitForTimeout(300);

  // Wheel over the menu: the list scrolls, the menu stays open, the page does not move.
  await menu.hover();
  const pageScrollBefore = await page.evaluate(() => document.getElementById('quoteRoot').scrollTop);
  await page.mouse.wheel(0, 120);
  await page.waitForTimeout(200);
  await expect(menu).toBeVisible();
  expect(await menu.evaluate((el) => el.scrollTop)).toBeGreaterThan(0);
  expect(await page.evaluate(() => document.getElementById('quoteRoot').scrollTop)).toBe(pageScrollBefore);

  // Wheel away from the menu: the existing dismiss-on-scroll behaviour is preserved.
  await page.locator('#f-firstName').hover();
  await page.mouse.wheel(0, 120);
  await expect(page.locator('.ch-ac-menu')).toHaveCount(0, { timeout: 2000 });
});
