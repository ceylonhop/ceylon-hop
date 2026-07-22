import { test, expect } from '@playwright/test';

// Spec 2026-07-22: the assignee picker moved into the header (before Submit/Save), label-less;
// a new quote is auto-assigned to its creator, so the picker opens already on the maker.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function stubOps(page, me = 'op@e2e.test') {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}) } };
  });
  const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({ product: 'private', total: { cents: 12100, lkr: 'x' }, lineItems: [], breakdown: { km: {}, legs: [{ priceCents: 12100 }] }, services: { pointToPoint: { total: { cents: 12100 } }, chauffeur: { error: 'x' } }, warnings: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: me, role: 'ops', caps: ['quote:manage'] })));
  // Roster for the picker options.
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [{ email: me, displayName: 'Op E' }, { email: 'other@e2e.test', displayName: 'Other O' }] })));
  await page.route('**/admin/quote/places**', (r) => { const q = new URL(r.request().url()).searchParams.get('q') || ''; r.fulfill(json({ places: [q], suggestions: [{ label: q, source: 'known' }] })); });
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  // A fresh save auto-assigns to the creator and returns assignedTo.
  await page.route('**/admin/quote/save', (r) => r.fulfill(json({ id: 'q1', reference: 'Q-ASN01', status: 'draft', assignedTo: me })));
  await page.route('**/admin/quote/q1', (r) => r.fulfill(json({})));
}

test('the assignee picker sits in the header before the actions, label-less, and shows the creator', async ({ page }) => {
  await stubOps(page, 'op@e2e.test');
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');

  // Before saving there is no id → no picker in the header.
  await expect(page.locator('.ch-header #assignSel')).toHaveCount(0);

  // Save → the quote gets an id and is auto-assigned to its creator.
  await page.locator('.ch-header [data-action="saveDraft"]').click();

  // The picker is now in the HEADER tools, before the action bar, with no "Assigned to" label.
  const picker = page.locator('.ch-header-tools #assignSel.ch-head-assign');
  await expect(picker).toBeVisible({ timeout: 10000 });
  await expect(page.locator('.ch-assign-lbl')).toHaveCount(0);
  // It opens on the creator (auto-assigned), tinted as "mine".
  await expect(picker).toHaveJSProperty('value', 'op@e2e.test');
  await expect(picker).toHaveClass(/mine/);
  // The picker renders to the left of the Save button in the header row.
  const px = (await picker.boundingBox());
  const sx = (await page.locator('.ch-header-tools [data-action="saveDraft"]').boundingBox());
  expect(px.x).toBeLessThan(sx.x);
});
