import { test, expect } from '@playwright/test';

// Owner 2026-09-23: the customer's phone number on every booking row in the ops queue, so
// ops can see who to message without opening the sheet. Board vans are one row per VAN,
// not per customer, and carry no number.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Test Customer',
  customerFirstName: 'Test', customerPhone: '+94 77 123 4567', mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking',
};

async function boot(page, bookings) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps: ['bookings:read'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(bookings)));
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

test('a booking row shows the customer phone number', async ({ page }) => {
  await boot(page, [ROW]);
  const row = page.locator('.tk[data-id="b1"]');
  await expect(row.locator('.tk-meta')).toContainText('+94 77 123 4567');
});

test('a booking with no number shows no stray separator or placeholder', async ({ page }) => {
  await boot(page, [{ ...ROW, customerPhone: null }]);
  const meta = page.locator('.tk[data-id="b1"] .tk-meta');
  await expect(meta).toContainText('2 guests');
  await expect(meta.locator('.tk-phone')).toHaveCount(0);
});
