import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Owner, 2026-08-02: Cancel and Refund are the two irreversible actions, so they now sit
// together at the FOOT of the sheet, they are founder-only (payments:reverse), and the refund
// is always the full remainder — our PayHere setup cannot do partials, so an amount box would
// only invite records the gateway can't honour. Refunds close 24 hours before travel.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const DAY = 86_400_000;
const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

const row = (travelDate) => ({
  id: 'b1', reference: 'CH-0001', channel: 'whatsapp', customerName: 'Test Customer',
  customerFirstName: 'Test', mode: 'single', route: 'Colombo → Kandy',
  travelDate, travelTime: '09:00', pax: 2, amount: 3900, currency: 'USD',
  stage: 'paid', paymentStatus: 'paid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '',
});

const detail = (travelDate) => ({
  booking: { id: 'b1', reference: 'CH-0001', currency: 'USD', status: 'paid' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
  events: [],
  travelDate,
});

async function boot(page, { caps, travelDate }) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Playwright gives precedence to the LAST matching route registered, so the catch-all goes
  // first and the specific stubs after it — the reverse order silently swallows whoami and the
  // shell never boots.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/b1/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row(travelDate)])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(detail(travelDate))));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  await page.locator('#view .tk[data-act="open"]').first().click();
  await page.waitForSelector('#sheet.show', { timeout: 10000 });
  await page.waitForSelector('#sheet .sheet-b', { timeout: 10000 });
}

const FOUNDER = ['bookings:read', 'bookings:operate', 'payments:act', 'payments:reverse'];
const FINANCE = ['bookings:read', 'payments:act']; // no payments:reverse

test('a founder sees Cancel and a full-amount Refund together, at the foot of the sheet', async ({ page }) => {
  await boot(page, { caps: FOUNDER, travelDate: iso(Date.now() + 10 * DAY) });

  const cancel = page.locator('[data-act="cancelbooking"]');
  const refund = page.locator('[data-act="refundrequest"]');
  await expect(cancel).toBeVisible();
  await expect(refund).toBeVisible();

  // Full remainder, stated on the button — never an amount box to type into.
  await expect(refund).toContainText('$39');
  await expect(page.locator('#refundamount')).toHaveCount(0);
  await expect(page.locator('#refundreason')).toHaveCount(0);

  // Side by side, in the same action row.
  const shared = page.locator('.reverse-actions', { has: page.locator('[data-act="cancelbooking"]') });
  await expect(shared.locator('[data-act="refundrequest"]')).toHaveCount(1);

  // …and that row is the LAST block in the sheet body, below everything worth reading first.
  const lastBlockText = await page.locator('.sheet-b > .block').last().innerText();
  expect(lastBlockText.toLowerCase()).toContain('cancel');
});

test('finance sees neither button — reversing a sale is founder-only', async ({ page }) => {
  await boot(page, { caps: FINANCE, travelDate: iso(Date.now() + 10 * DAY) });
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.locator('[data-act="refundrequest"]')).toHaveCount(0);
  // But the refund LEDGER is still readable — finance has to reconcile the books.
  await expect(page.locator('#sheet')).toContainText('Refundable remaining');
});

test('refunds close 24 hours before travel', async ({ page }) => {
  // 12 hours out — inside the cut-off.
  await boot(page, { caps: FOUNDER, travelDate: iso(Date.now() + 0.5 * DAY) });
  await expect(page.locator('[data-act="refundrequest"]')).toHaveCount(0);
  await expect(page.locator('button[disabled]', { hasText: 'Refund' })).toBeVisible();
  await expect(page.locator('#sheet')).toContainText('Refunds close 24 hours before travel');
  // Cancel is NOT bound by the refund cut-off — a late trip can still be called off.
  await expect(page.locator('[data-act="cancelbooking"]')).toBeVisible();
});

test('a booking with no travel date stays refundable', async ({ page }) => {
  // "Flexible" bookings have no date. Blocking them would strand exactly the ones most likely
  // to be called off — there is no departure to be late for yet.
  await boot(page, { caps: FOUNDER, travelDate: null });
  await expect(page.locator('[data-act="refundrequest"]')).toBeVisible();
});
