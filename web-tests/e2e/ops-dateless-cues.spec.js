import { test, expect } from '@playwright/test';

// Dateless booking capture, Phase 3 (spec 2026-10-17 §5). In the queue, an undated paid booking
// says how long ago the money landed (amber from 7 days), and a dated private transfer with no
// pickup time says "time to confirm" where the time would be.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const daysFromNow = (n) => { const d = new Date(); d.setDate(d.getDate() + n); d.setHours(12, 0, 0, 0); return d; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Test Customer',
  customerFirstName: 'Test', customerPhone: '+94 77 123 4567', mode: 'single', route: 'Colombo → Kandy',
  travelDate: null, travelTime: null, pax: 2, amount: 10000, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking', paidAt: null,
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

test('an undated paid booking shows days since payment, amber from 7', async ({ page }) => {
  await boot(page, [
    { ...ROW, id: 'old', reference: 'CH-OLD01', paidAt: daysFromNow(-9).toISOString() },
    { ...ROW, id: 'new', reference: 'CH-NEW01', paidAt: daysFromNow(-2).toISOString() },
  ]);
  const old = page.locator('.tk[data-id="old"] .tk-paid');
  await expect(old).toHaveText('paid 9 days ago');
  await expect(old).toHaveClass(/late/);
  const fresh = page.locator('.tk[data-id="new"] .tk-paid');
  await expect(fresh).toHaveText('paid 2 days ago');
  await expect(fresh).not.toHaveClass(/late/);
});

test('a dated booking does not show days since payment', async ({ page }) => {
  await boot(page, [{ ...ROW, travelDate: isoDay(daysFromNow(5)), travelTime: '09:00', paidAt: daysFromNow(-9).toISOString() }]);
  await expect(page.locator('.tk[data-id="b1"] .tk-meta')).toContainText('2 guests');
  await expect(page.locator('.tk[data-id="b1"] .tk-paid')).toHaveCount(0);
});

test('a dated transfer with no pickup time says "time to confirm"; one with a time does not', async ({ page }) => {
  const date = isoDay(daysFromNow(5));
  await boot(page, [
    { ...ROW, id: 'tbc', travelDate: date },
    { ...ROW, id: 'set', reference: 'CH-0002', travelDate: date, travelTime: '09:00' },
    { ...ROW, id: 'trip', reference: 'CH-0003', mode: 'trip', travelDate: date },
  ]);
  await expect(page.locator('.tk[data-id="tbc"] .when')).toContainText('time to confirm');
  await expect(page.locator('.tk[data-id="set"] .when')).toContainText('09:00');
  await expect(page.locator('.tk[data-id="set"] .tk-tbc')).toHaveCount(0);
  await expect(page.locator('.tk[data-id="trip"] .tk-tbc')).toHaveCount(0);
});
