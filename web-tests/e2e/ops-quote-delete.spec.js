import { test, expect } from '@playwright/test';

// Role-gated soft delete of a quote (spec 2026-07-22). The button appears only for the
// state+role the server allows; clicking it confirms, soft-deletes, and returns to the queue.
// The server is authoritative — these tests cover the UI wiring (button visibility + the
// DELETE round-trip); the gating matrix itself is unit-tested in api/internalQuote.test.ts.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const RATE_CARD = {
  rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 }, van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 } },
  chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
};

async function setup(page, { role = 'founder' } = {}) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({}))); // catch-all FIRST so the specific routes below win
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json({ product: 'private', total: { cents: 12100, lkr: 'x' }, lineItems: [], breakdown: { km: {} }, services: { pointToPoint: { total: { cents: 12100 } }, chauffeur: { error: 'x' } }, warnings: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: role === 'founder' ? 'f@e2e.test' : 'op@e2e.test', role, caps: ['quote:manage'] })));
  await page.route('**/admin/quote/save', (r) => r.fulfill(json({ id: 'q1', reference: 'Q-DEL01', status: 'draft' })));
}

async function buildDraft(page) {
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'Karen');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  await page.locator('[data-action="setRequestedService"][data-req="private"]').first().click();
  await page.waitForSelector('.ch-tl-title[data-field="pickupLocation"]', { timeout: 10000 });
  const from = page.locator('.ch-tl-title[data-field="pickupLocation"]').first();
  const to = page.locator('.ch-tl-title[data-field="dropoffLocation"]').first();
  await from.fill('Colombo'); await from.dispatchEvent('change');
  await to.fill('Kandy'); await to.dispatchEvent('change');
}

test('a saved draft shows Delete; confirming soft-deletes and returns to the queue', async ({ page }) => {
  test.slow();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  let deleteHit = null;
  await setup(page, { role: 'founder' });
  await page.route('**/admin/quote/q1', (r) => {
    if (r.request().method() === 'DELETE') { deleteHit = r.request().url(); return r.fulfill(json({ id: 'q1', deleted: true })); }
    return r.fulfill(json({}));
  });
  await buildDraft(page);
  // Persist the draft so it has a savedId (the Delete button only shows for a saved quote).
  await page.locator('.ch-btn[data-action="saveDraft"]').click();
  const del = page.locator('.ch-btn[data-action="deleteQuote"]');
  await expect(del).toBeVisible({ timeout: 10000 });
  await expect(del).toHaveText('Delete');
  // Confirm the delete; it should soft-delete and bounce back to the queue (builder hidden).
  page.on('dialog', (d) => d.accept());
  await del.click();
  await expect.poll(() => deleteHit, { timeout: 10000 }).toContain('/admin/quote/q1');
  await expect(page.locator('#quoteRoot')).toBeHidden({ timeout: 10000 });
  expect(errors).toEqual([]);
});

test('a draft with no savedId shows no Delete button (nothing to delete yet)', async ({ page }) => {
  test.slow();
  await setup(page, { role: 'founder' });
  await buildDraft(page);
  // Not saved → no id → no Delete. (Start-new handles discarding an unsaved draft.)
  await expect(page.locator('.ch-btn[data-action="deleteQuote"]')).toHaveCount(0);
});
