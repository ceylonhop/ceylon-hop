import { test, expect } from '@playwright/test';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Owner, 2026-08-02: Cancel and Refund are the two irreversible actions, founder-only
// (payments:reverse), and the refund is always the full remainder — our PayHere setup cannot
// do partials, so an amount box would only invite records the gateway can't honour. Since #357
// (2026-08-07) the refund request lives INSIDE the Refunds block beside the money it acts on,
// and Cancel booking keeps the foot of the sheet — each with its own required reason field.
//
// Owner rule, later the same day: an OPS agent may also cancel/refund, but only while more than
// 24 hours remain before the trip starts, and a reason is required and stored. A FOUNDER is
// never time-limited — which reverses the earlier "refunds close 24 hours before travel" rule
// as it applied to founders.

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
const FINANCE = ['bookings:read', 'payments:act']; // no payments:reverse, and no bookings:operate
// Owner rule 2026-08-02: an ops agent may cancel/refund up to 24h before the trip, with a reason.
const OPS = ['bookings:read', 'bookings:operate'];

test('a founder sees a full-amount Refund in the Refunds block, and Cancel at the foot of the sheet', async ({ page }) => {
  await boot(page, { caps: FOUNDER, travelDate: iso(Date.now() + 10 * DAY) });

  const cancel = page.locator('[data-act="cancelbooking"]');
  const refund = page.locator('[data-act="refundrequest"]');
  await expect(cancel).toBeVisible();
  await expect(refund).toBeVisible();

  // Full remainder, stated on the button — never an amount box to type into. The reason field
  // is required and inline (one per action since the 2026-08-07 split).
  await expect(refund).toContainText('$39');
  await expect(page.locator('#refundamount')).toHaveCount(0);
  await expect(page.locator('#refundreason')).toBeVisible();

  // The refund request sits in the Refunds block, beside the money it acts on (#357).
  const refunds = page.locator('.block', { has: page.locator('h4', { hasText: 'Refunds' }) });
  await expect(refunds.locator('[data-act="refundrequest"]')).toHaveCount(1);

  // …and Cancel booking is the LAST block in the sheet body, below everything worth reading first.
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

test('a FOUNDER is never time-limited — 12 hours out, both actions stay live', async ({ page }) => {
  await boot(page, { caps: FOUNDER, travelDate: iso(Date.now() + 0.5 * DAY) });
  await expect(page.locator('[data-act="refundrequest"]')).toBeVisible();
  await expect(page.locator('[data-act="cancelbooking"]')).toBeVisible();
  // Two reason fields since the split (2026-08-07): the refund one lives with the refund
  // request in the Refunds block, the cancel one with Cancel booking.
  await expect(page.locator('#refundreason')).toBeVisible();
  await expect(page.locator('#cancelreason')).toBeVisible();
});

test('an OPS agent may reverse while more than 24 hours remain', async ({ page }) => {
  await boot(page, { caps: OPS, travelDate: iso(Date.now() + 10 * DAY) });
  await expect(page.locator('[data-act="cancelbooking"]')).toBeVisible();
  await expect(page.locator('#cancelreason')).toBeVisible();
});

test('an OPS agent is locked out inside the last 24 hours, and told why', async ({ page }) => {
  await boot(page, { caps: OPS, travelDate: iso(Date.now() + 0.5 * DAY) });
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.locator('[data-act="refundrequest"]')).toHaveCount(0);
  await expect(page.locator('#sheet')).toContainText('only a founder can cancel or refund');
  // No reason box either — there is nothing here they can do.
  await expect(page.locator('#cancelreason')).toHaveCount(0);
  await expect(page.locator('#refundreason')).toHaveCount(0);
});

test('an OPS agent cannot reverse a booking with no trip date — fails closed', async ({ page }) => {
  await boot(page, { caps: OPS, travelDate: null });
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.locator('#sheet')).toContainText('no trip date');
});

test('a FOUNDER can still reverse a booking with no travel date', async ({ page }) => {
  // "Flexible" bookings have no date. Ops fails closed on these (above); a founder does not,
  // or the ones most likely to be called off would be stranded.
  await boot(page, { caps: FOUNDER, travelDate: null });
  await expect(page.locator('[data-act="refundrequest"]')).toBeVisible();
});
