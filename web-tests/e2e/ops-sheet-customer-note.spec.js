import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// The booking sheet shows what the customer wrote in the booking page's "Anything we should
// know?" box (booking.customerNotes, 2026-09-27) — only when they wrote something, and always as
// text: the note is typed by the public, so markup in it must never become markup in the sheet.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const NOTE = 'Galle Face Hotel, side gate <img src=x onerror="window.__pwned=1">\nTwo surfboards';

const row = (id, ref, name) => ({
  id, reference: ref, channel: 'website', customerName: name, customerFirstName: name.split(' ')[0],
  mode: 'single', route: 'Colombo → Galle', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 2,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null,
});

const detail = (id, customerNotes) => ({
  payLink: null,
  booking: { id, reference: id === 'b1' ? 'CH-0001' : 'CH-0002', currency: 'USD', status: 'paid',
    mode: 'single', createdAt: '2026-09-01T00:00:00Z', customerNotes,
    input: { customer: { whatsapp: '+94 77 000 0000', email: `${id}@example.com`, country: 'Spain' } } },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
});

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all first: Playwright gives precedence to the LAST matching route.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([
    row('b1', 'CH-0001', 'Alpha Customer'), row('b2', 'CH-0002', 'Bravo Customer'),
  ])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(detail('b1', NOTE))));
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(detail('b2', null))));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}

test("the booking sheet shows the customer's note as plain text", async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  const noteRow = page.locator('.sheet-b .kv', { has: page.locator('.k', { hasText: /^Note$/ }) });
  await expect(noteRow).toHaveCount(1);
  await expect(noteRow.locator('.v')).toHaveText(NOTE);
  // The markup arrived as characters, not as an element that ran.
  await expect(noteRow.locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

test('a booking with no note has no Note row', async ({ page }) => {
  await boot(page);
  await open(page, 'b2');
  await expect(page.locator('.sheet-b')).toContainText('b2@example.com');
  await expect(page.locator('.sheet-b .kv .k', { hasText: /^Note$/ })).toHaveCount(0);
});
