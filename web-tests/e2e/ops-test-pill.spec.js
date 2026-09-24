import { test, expect } from '@playwright/test';

// Test bookings (2026-09-24): a row whose customer email is one of the team's (TEAM_EMAILS)
// carries `isTest`. The queue labels it with a small "test" pill, keeps it visible, and leaves
// it out of the "need attention" count and the filter-chip counts — the owner's own re-tests
// were inflating every number in the queue and the digest.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Test Customer',
  customerFirstName: 'Test', customerPhone: null, mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD',
  // awaiting_payment is a "needs attention" stage, so the count below is meaningful.
  stage: 'awaiting_payment', paymentStatus: 'unpaid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking', isTest: false,
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

test('a team test booking shows a "test" pill and stays in the list', async ({ page }) => {
  await boot(page, [{ ...ROW, isTest: true }, { ...ROW, id: 'b2', reference: 'CH-0002', customerName: 'Real Customer' }]);
  await expect(page.locator('.tk[data-id="b1"] .tk-test')).toHaveText('test');
  await expect(page.locator('.tk[data-id="b2"] .tk-test')).toHaveCount(0);
  await expect(page.locator('.tk')).toHaveCount(2);
});

test('test bookings are left out of the attention and chip counts', async ({ page }) => {
  await boot(page, [{ ...ROW, isTest: true }, { ...ROW, id: 'b2', reference: 'CH-0002', customerName: 'Real Customer' }]);
  // Two awaiting-payment rows, one of them a test → exactly one needs attention.
  await expect(page.locator('.pagesub .a')).toHaveText('1 need attention');
  await expect(page.locator('#nav-attn')).toHaveText('1');
  // The "all" filter chip counts open work; the test row is not counted there either.
  await expect(page.locator('.fchip[data-g="all"] .fc')).toHaveText('1');
});
