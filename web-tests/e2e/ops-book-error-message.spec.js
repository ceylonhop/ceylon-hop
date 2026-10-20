import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';
import { futureIsoDate } from '../dates.js';

// "Mark booked" refused by the server (staging, 2026-10-13): POST /admin/quote/:id/book answered
// 409 with a full `reason` + `message`, and the agent's toast said only "Could not book —
// not_bookable". bookErrorText() already knows what to do with reason/message/details and is
// unit-tested as a pure function (unit/ops-book-error-text.test.js) — but apiBook() handed it
// only `{ error }`, so none of that copy was reachable. This drives the REAL path (button → modal
// → Confirm → toast) so the wiring is what is under test. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const OTHER_OPTION_COPY = "A Chauffeur-guide payment was started on this quote, so it can't be marked booked as Point-to-point. Reopen the quote and price it as Chauffeur-guide, or send the customer a payment link.";

const SENT_QUOTE = {
  id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'sent', product: 'private', vehicle: 'car',
  customerName: 'Maya Silva', customerContact: '+44 7700 900000', totalCents: 14900, currency: 'USD',
  notes: null, createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
  request: {
    tool: {
      name: 'Maya Silva', contact: '+44 7700 900000', vehicle: 'car', service: 'private',
      requestedService: 'private', passengerCount: 2, luggageCount: 2,
      legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
    },
  },
  result: { totalCents: 14900 },
  customerTotalVia: 'quote_link',
  estimate: {
    product: 'private',
    total: { cents: 14900, lkr: 'LKR 49,170' },
    lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 14900 }],
    warnings: [],
  },
  payOptions: null,
};

// Open the sent quote, press Mark booked, fill the modal and Confirm — with /book answering `answer`.
async function markBooked(page, answer) {
  const posts = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await routeOpsEstimate(page);
  await page.route('**/admin/quote/q1', (r) => r.fulfill(json(SENT_QUOTE)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [{
    id: 'q1', reference: 'Q-Q1', customerName: 'Maya Silva', product: 'private', vehicle: 'car', totalCents: 14900, currency: 'USD', status: 'sent',
  }] })));
  await page.route('**/admin/quote/q1/book', (r) => { posts.push(r.request().postData()); r.fulfill(answer); });
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'founder@e2e.test', role: 'founder',
    caps: ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'bookings:operate', 'payments:act'],
  })));
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view .qrow[data-qopen="q1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await expect(page.locator('.ch-status-pill')).toHaveText('Sent', { timeout: 10000 });
  await page.waitForLoadState('networkidle');

  await page.locator('.ch-actionbar [data-action="markWon"]').click();
  await page.locator('#bk-first').fill('Maya');
  await page.locator('#bk-last').fill('Silva');
  await page.locator('#bk-email').fill('maya@example.com');
  await page.locator('#bk-whatsapp').fill('+44 7700 900000');
  await page.locator('#bk-country').fill('GB');
  await page.locator('#bk-date').fill(futureIsoDate(30));
  await page.locator('#bk-time').fill('09:30');
  await page.locator('[data-action="confirmBook"]').click();
  // The refusal under test is the SERVER's: the request really went out.
  await expect.poll(() => posts.length).toBe(1);
}
const toast = (page) => page.locator('#ch-toast');
const toastMsg = (page) => page.locator('#ch-toast .ch-toast-msg');

test('the other option was started: the toast says what happened and what to do, not "not_bookable"', async ({ page }) => {
  await markBooked(page, json({ error: 'not_bookable', reason: 'other_option_started', message: OTHER_OPTION_COPY }, 409));
  await expect(toast(page)).toHaveClass(/show/);
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toastMsg(page)).toHaveText(OTHER_OPTION_COPY);
  await expect(toastMsg(page)).not.toContainText('not_bookable');
});

test('already booked: the toast names the booking', async ({ page }) => {
  await markBooked(page, json({
    error: 'already_booked', reference: 'CH-ABCDE', status: 'paid',
    message: 'This quote is already booked as CH-ABCDE, and that booking is paid — its details can no longer be changed here. Open it from the Bookings queue.',
  }, 409));
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toastMsg(page)).toContainText('already booked as CH-ABCDE');
});

test('a rejected field: the toast names the field', async ({ page }) => {
  await markBooked(page, json({
    error: 'bad_request', message: 'customer.email: Invalid email',
    details: { fieldErrors: { customer: ['Invalid email'] } },
  }, 400));
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toastMsg(page)).toContainText('customer.email: Invalid email');
});

test('a non-JSON 500 still falls back to the status code', async ({ page }) => {
  await markBooked(page, { status: 500, contentType: 'text/html', body: '<html><body>Internal Server Error</body></html>' });
  await expect(toast(page)).toHaveClass(/bad/);
  await expect(toastMsg(page)).toHaveText('Could not book — HTTP 500');
});
