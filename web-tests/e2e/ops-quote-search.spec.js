import { test, expect } from '@playwright/test';

// Search on the Quotes queue (spec 2026-07-25). The filter itself is unit-tested in
// web-tests/unit/ops-quote-search.test.js; this covers the wiring — flatten, matched place,
// the chip-mismatch escape hatch, and clearing back to the grouped queue.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const q = (o) => ({
  customerContact: null, currency: 'USD', assignedTo: null, vehicle: 'car', product: 'private', ...o,
});
const QUOTES = [
  q({ id: 'q1', reference: 'Q-AAAAA', status: 'ready', customerName: 'Sonja', totalCents: 10700,
      createdAt: '2026-07-20T00:00:00.000Z', routeText: 'Colombo Airport · Galle · Ella' }),
  q({ id: 'q2', reference: 'Q-BBBBB', status: 'draft', customerName: 'Nikolaj', totalCents: 11500,
      createdAt: '2026-07-19T00:00:00.000Z', routeText: 'Colombo · Kandy' }),
  q({ id: 'q3', reference: 'Q-CCCCC', status: 'sent', customerName: null, totalCents: 4500,
      createdAt: '2026-07-18T00:00:00.000Z', routeText: null }),
];

async function setup(page) {
  await page.addInitScript(() => { window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } } }; });
  await page.route('**/admin/**', (r) => r.fulfill(json({}))); // catch-all FIRST so the specific routes below win
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: QUOTES })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve'] })));
  await page.goto(OPS_FILE + '#quotes');
  await page.waitForSelector('#view .qrow', { timeout: 10000 });
}

test('searching flattens the queue and shows the matched place', async ({ page }) => {
  await setup(page);
  await expect(page.locator('#view .qsection')).toHaveCount(3); // grouped: mine + status sections
  await expect(page.locator('#view .qrow')).toHaveCount(3);

  await page.fill('#qq', 'ella');

  await expect(page.locator('#view .qsec-results')).toHaveCount(1);
  await expect(page.locator('#view .qsection-title')).toHaveText(/^Results1$/);
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#view .qrow .qprod')).toHaveText('… Ella');
  await expect(page.locator('#view .pagesub')).toContainText('1 of 3 quotes match');
});

test('an unnamed draft is findable by the label the row shows', async ({ page }) => {
  await setup(page);
  await page.fill('#qq', 'untitled');
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#view .qrow .qcust')).toHaveText('Untitled');
});

test('a chip that hides every match says so and offers a way out', async ({ page }) => {
  await setup(page);
  await page.locator('#view [data-qfilter="progress"]').click(); // draft/pending/changes only
  await page.fill('#qq', 'ella');                                // q1 is 'ready'

  await expect(page.locator('#view .qempty-title')).toHaveText('No match in In progress');
  await expect(page.locator('#view .qempty-sub')).toContainText('1 quote match');

  await page.locator('#view .qempty [data-qfilter="all"]').click();
  await expect(page.locator('#view .qrow')).toHaveCount(1);
  await expect(page.locator('#qq')).toHaveValue('ella'); // the query survived the chip reset
});

test('Escape clears the box and restores the grouped queue', async ({ page }) => {
  await setup(page);
  await page.fill('#qq', 'ella');
  await expect(page.locator('#view .qrow')).toHaveCount(1);

  await page.locator('#qq').press('Escape');

  await expect(page.locator('#qq')).toHaveValue('');
  await expect(page.locator('#view .qsec-results')).toHaveCount(0);
  await expect(page.locator('#view .qrow')).toHaveCount(3);
});
