import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
// Regressions for design-review D1 (collapsed rail swallowed the first click) and
// D9 (theme toggle left stale chrome on the topbar search / filter chips).

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubShell(page) {
  await page.addInitScript(() => {
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: MapCls, places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } }, importLibrary: async () => ({}) },
    };
    try { localStorage.setItem('ch_ops_theme', 'dark'); } catch (e) {}
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/quotes**', (r) => r.fulfill(json({ quotes: [] })));
}

test('D1: a single click on the collapsed rail navigates (no swallowed first click)', async ({ page }) => {
  await stubShell(page);
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) .rail', { timeout: 10000 });

  // Force the collapsed state the auto-hide sidebar spends most of its time in.
  await page.evaluate(() => { localStorage.setItem('ch_ops_rail', '1'); applyRailState(); });
  await expect(page.locator('#approot')).toHaveClass(/rail-collapsed/);

  // ONE click on the Quotes nav button must navigate — before the fix a capture handler
  // swallowed it (only expanding), so the route didn't change until a second click.
  await page.locator('#nav [data-route="quotes"]').click();
  await expect(page.locator('#view [data-qnew]')).toBeVisible({ timeout: 5000 });
  expect(new URL(page.url()).hash).toContain('quotes');
});

test('D9: toggling the theme repaints the topbar search field (no stale dark chrome)', async ({ page }) => {
  await stubShell(page); // boots in dark (localStorage above)
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) #topbar', { timeout: 10000 });
  await expect(page.locator('#q')).toBeVisible({ timeout: 5000 });

  const bg = () => page.locator('#q').evaluate((el) => getComputedStyle(el).backgroundColor);
  const darkBg = await bg();

  // Switch to light via the same path the rail button uses.
  await page.evaluate(() => toggleTheme());
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');

  // The search field must actually repaint to the light surface — not keep the dark colour.
  await expect.poll(bg, { timeout: 3000 }).not.toBe(darkBg);
});
