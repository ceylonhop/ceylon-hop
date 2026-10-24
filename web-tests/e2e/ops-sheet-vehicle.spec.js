import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// The booking sheet names the vehicle ops have to assign — the tier the trip was priced on, which
// the API sends as `vehicle` (car | van | van9 | van14 | custom; null for a shared seat).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const row = (id, ref, mode) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode, route: 'Colombo → Galle', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 8,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null,
});

const detail = (id, mode, vehicle) => ({
  payLink: null, vehicle,
  booking: { id, reference: id === 'b1' ? 'CH-0001' : 'CH-0002', currency: 'USD', status: 'paid',
    mode, createdAt: '2026-09-01T00:00:00Z',
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
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row('b1', 'CH-0001', 'single'), row('b2', 'CH-0002', 'shared')])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(detail('b1', 'single', 'van9'))));
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(detail('b2', 'shared', null))));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}

test('the booking sheet names the vehicle the trip was priced on', async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  await expect(page.getByTestId('sheet-vehicle')).toHaveText('Van 9 Seat');
});

test('a shared seat has no Vehicle row', async ({ page }) => {
  await boot(page);
  await open(page, 'b2');
  await expect(page.locator('.sheet-b')).toContainText('b2@example.com');
  await expect(page.locator('.sheet-b .kv .k', { hasText: /^Vehicle$/ })).toHaveCount(0);
});
