import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
// Covers the 2026-07-23 nav changes:
//  - default landing: no (recognised) hash → Quotes queue for quote:manage holders,
//    Bookings for everyone else (Bookings keeps its own #bookings hash for history);
//  - the Bookings attention badge renders only when the count is non-zero — a red "0"
//    is noise.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

// One booking in the 'paid' stage → reason() = "Vehicle not confirmed yet" → isAttn.
const ATTN_ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'web', customerName: 'Test Customer',
  customerFirstName: 'Test', mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '',
};

async function boot(page, { caps, bookings }) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(bookings)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

test('quote:manage holder lands on the Quotes queue by default', async ({ page }) => {
  await boot(page, { caps: ['quote:manage'], bookings: [] });
  await expect(page.locator('#view .qhead h1')).toHaveText('Quotes');
  expect(new URL(page.url()).hash).toBe('#quotes');
});

test('a role without quote:manage still lands on Bookings', async ({ page }) => {
  await boot(page, { caps: ['bookings:read'], bookings: [] });
  await expect(page.locator('#view h1')).toHaveText('Bookings');
  await expect(page.locator('#nav button[data-route="quotes"]')).toHaveCount(0);
});

test('the Bookings attention badge is hidden at zero', async ({ page }) => {
  await boot(page, { caps: ['quote:manage'], bookings: [] });
  // Wait until the bookings fetch has actually landed (the empty state paints) so the
  // "no badge" assertion isn't just racing the load.
  await page.locator('#nav button[data-route="tickets"]').click();
  await expect(page.locator('.qempty-title')).toHaveText('No bookings yet', { timeout: 10000 });
  // Zero attention → no badge at all (not a red "0").
  await expect(page.locator('#nav-attn')).toHaveCount(0);
});

test('the Bookings attention badge shows the count when bookings need action', async ({ page }) => {
  await boot(page, { caps: ['quote:manage'], bookings: [ATTN_ROW] });
  await expect(page.locator('#nav-attn')).toHaveText('1');
});
