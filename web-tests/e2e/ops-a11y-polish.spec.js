import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
// Regressions for the 2026-07-21 design review's polish list (committed in
// docs/design-review-ops-ui-2026-07-21.md): booking cards keyboard-reachable with real
// accessible names, quote rows carrying an accessible name, whole-dollar list prices,
// and the login layer leaving the page (hidden/inert) once signed in.

const OPS_FILE = '/api/src/routes/ops-ui.html';

const BOOKING = {
  id: 'b-1', reference: 'CH-KBD01', channel: 'website', customerName: 'Maya Silva',
  customerFirstName: 'Maya', mode: 'single', route: 'Colombo Airport → Ella',
  travelDate: '2027-03-10', travelTime: '08:00', pax: 2, amount: 12300, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '',
};

const QUOTE = {
  id: 'q-1', reference: 'Q-AXB21', customerName: 'Silke Weber', product: 'chauffeur',
  vehicle: 'van', totalCents: 443906, status: 'draft', assignedTo: null,
  createdAt: new Date().toISOString(),
};

async function stubShell(page) {
  await page.addInitScript(() => {
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: MapCls, places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } }, importLibrary: async () => ({}) },
    };
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([BOOKING])));
  await page.route('**/admin/quote/list', (r) => r.fulfill(json({ quotes: [QUOTE] })));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
}

test('booking cards are keyboard-reachable buttons with an accessible name', async ({ page }) => {
  await stubShell(page);
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden])', { timeout: 10000 });

  const card = page.locator('#view .tk[data-act="open"]');
  await expect(card).toHaveCount(1);
  // Reachable + announced: same pattern the quote rows already use.
  await expect(card).toHaveAttribute('role', 'button');
  await expect(card).toHaveAttribute('tabindex', '0');
  await expect(card).toHaveAttribute('aria-label', /CH-KBD01/);
  await expect(card).toHaveAttribute('aria-label', /Maya Silva/);

  // Enter opens the booking sheet, exactly like a click.
  await card.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sheet.show')).toBeVisible({ timeout: 5000 });
});

test('quote rows carry an accessible name and a whole-dollar list price', async ({ page }) => {
  await stubShell(page);
  await page.goto(OPS_FILE + '#quotes');
  await page.waitForSelector('#approot:not([hidden])', { timeout: 10000 });

  const row = page.locator('#view .qrow[data-qopen]');
  await expect(row).toHaveCount(1);
  await expect(row).toHaveAttribute('aria-label', /Q-AXB21/);
  await expect(row).toHaveAttribute('aria-label', /Silke Weber/);

  // List price is a glance value — whole dollars, not raw cents (detail views keep cents).
  await expect(row.locator('.qtotal')).toHaveText('$4,439');
});

test('the login layer is hidden and inert once signed in', async ({ page }) => {
  await stubShell(page);
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden])', { timeout: 10000 });

  // The fixed-position login overlay must leave the page for assistive tech and the tab
  // order — not just fade to opacity 0 behind the app.
  await expect(page.locator('#login')).toBeHidden({ timeout: 5000 });
  await expect(page.locator('#login')).toHaveAttribute('inert', '');
});
