import { test, expect } from '@playwright/test';

// Stale-open race (owner report 2026-07-22): clicking Sandra Wolker's quote opened Gahen's
// quote. reopenQuote() had no request-sequence guard, so when two opens overlapped the LAST
// HTTP response to arrive won the builder regardless of click order — a slow first open
// (cold API, first-time builder mount) clobbered the quote clicked after it. reopenQuote now
// discards a response whose open-generation token is stale. This spec stages the race
// deterministically: open Gahen (response HELD), back to the list, open Sandra (instant
// response), then release Gahen's stale response — the builder must still show Sandra.
// Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const quoteDetail = (id, firstName, lastName) => ({
  id, reference: 'Q-' + id.toUpperCase(), channel: 'ops', status: 'ready',
  product: 'private', vehicle: 'car',
  customerName: (firstName + ' ' + lastName).trim(), customerContact: '+94 77 123 4567',
  totalCents: 12100, currency: 'USD', notes: null,
  createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
  createdBy: 'founder@e2e.test', updatedBy: 'founder@e2e.test',
  request: { tool: {
    name: (firstName + ' ' + lastName).trim(), firstName, lastName,
    contact: '+94 77 123 4567', vehicle: 'car', service: 'private',
    requestedService: 'private', passengerCount: 2, luggageCount: 2,
    legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
  } },
  result: { totalCents: 12100 },
  estimate: {
    product: 'private', total: { cents: 12100, lkr: 'LKR 39,930' },
    lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 12100 }], warnings: [],
  },
});

test('stale slow response from a previous open must not clobber the quote opened after it', async ({ page }) => {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) } };
  });

  // Catch-all FIRST; specific routes after (Playwright: last-registered wins).
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [
    { id: 'gahen1', reference: 'Q-GAHEN1', customerName: 'Gahen Perera', product: 'private', vehicle: 'car', totalCents: 12100, currency: 'USD', status: 'ready' },
    { id: 'sandra1', reference: 'Q-SANDRA1', customerName: 'Sandra Wolker', product: 'private', vehicle: 'car', totalCents: 17800, currency: 'USD', status: 'ready' },
  ] })));

  // Gahen's detail GET is HELD until the test releases it — the "slow response".
  let releaseGahen;
  const gahenHeld = new Promise((res) => { releaseGahen = res; });
  await page.route(/\/admin\/quote\/gahen1$/, async (r) => {
    await gahenHeld;
    await r.fulfill(json(quoteDetail('gahen1', 'Gahen', 'Perera')));
  });
  // Sandra's detail GET resolves immediately.
  await page.route(/\/admin\/quote\/sandra1$/, (r) => r.fulfill(json(quoteDetail('sandra1', 'Sandra', 'Wolker'))));

  await page.goto(OPS_FILE + '#quotes');

  // Step 1: click Gahen's row. The open starts; its response hangs.
  await page.locator('.qrow[data-qopen="gahen1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Step 2: back to the quotes list (Gahen's GET is still in flight).
  await page.goBack();
  await expect(page.locator('.qrow[data-qopen="sandra1"]')).toBeVisible({ timeout: 10000 });

  // Step 3: click Sandra's row. Her response lands instantly — builder shows Sandra.
  await page.locator('.qrow[data-qopen="sandra1"]').click();
  await expect(page.locator('#f-firstName')).toHaveValue('Sandra', { timeout: 10000 });

  // Step 4: NOW the stale Gahen response finally arrives.
  releaseGahen();

  // Give the stale handler a beat to (wrongly) repaint, then assert the CONTRACT: the
  // builder still shows the quote that was clicked LAST, and the URL agrees with it.
  await page.waitForTimeout(500);
  await expect(page.locator('#f-firstName')).toHaveValue('Sandra');
  expect(page.url()).toContain('quote=sandra1');
});
