import { test, expect } from '@playwright/test';

// Ops quote tool must not let an operator add a leg date in the past: native min=today blocks
// the calendar, and the change handler rejects a typed/pasted past value. Offline webServer, no DB.

const OPS_FILE = '/api/src/routes/ops-ui.html';

async function openQuote(page) {
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
}

test('ops leg date input blocks past dates', async ({ page }) => {
  await openQuote(page);
  const dateInput = page.locator('.ch-leg-date input[type="date"]').first();
  await expect(dateInput).toBeVisible();

  const todayIso = await page.evaluate(() => {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  });
  // native calendar floor is today (no earlier date is selectable)
  await expect(dateInput).toHaveAttribute('min', todayIso);

  // a typed/pasted past value is rejected and cleared
  await dateInput.fill('2020-01-01');
  await dateInput.dispatchEvent('change');
  await expect(dateInput).toHaveValue('');
});
