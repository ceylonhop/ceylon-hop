import { test, expect } from '@playwright/test';
import { routeOpsEstimate } from './_ops-estimate.js';

// Owner, 2026-10-12: "after the deposit is paid, there is no place to get the balance payment
// link again, that link should be available both in the quote and in the booking pane". The
// booking pane has it (ops-balance.spec.js); this is the quote. A won quote whose booking still
// owes a balance offers ONE button that copies the customer's own pay link — the link read with
// the quote, no call on press. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const PAY_LINK = 'https://pay.example/p?t=SIGNED-TOKEN';
const FOUNDER = { email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'bookings:operate', 'payments:act'] };
const OPS = { email: 'ops@e2e.test', role: 'ops', caps: ['quote:manage', 'quote:approve_simple', 'bookings:read', 'bookings:operate'] };

function wonQuote(over = {}) {
  return {
    id: 'q1', reference: 'Q-Q1', channel: 'ops', status: 'won', product: 'private', vehicle: 'car',
    customerName: 'Maya', customerContact: '+44 7700 900000', totalCents: 21900, currency: 'USD',
    notes: null, createdAt: '2026-07-08T09:00:00.000Z', updatedAt: '2026-07-08T10:00:00.000Z',
    request: {
      tool: {
        name: 'Maya', contact: '+44 7700 900000', vehicle: 'car', service: 'private',
        requestedService: 'private', passengerCount: 2, luggageCount: 2,
        legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
      },
    },
    result: { totalCents: 21900 },
    customerTotalVia: 'pay_link',
    estimate: {
      product: 'private',
      total: { cents: 21900, lkr: 'LKR 72,270' },
      lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 21900 }],
      warnings: [],
    },
    payOptions: null,
    convertedBookingId: 'booking-1',
    balancePayLink: PAY_LINK,
    balanceCents: 16900,
    ...over,
  };
}

async function openQuote(page, quote, who = FOUNDER) {
  const calls = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
    // The clipboard is the observable: record what was written instead of needing a permission.
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } }, configurable: true });
  });
  await page.route('**/admin/**', (r) => { calls.push(r.request().method() + ' ' + new URL(r.request().url()).pathname); r.fulfill(json({})); });
  await routeOpsEstimate(page);
  await page.route('**/admin/quote/q1', (r) => r.fulfill(json(quote)));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [{
    id: 'q1', reference: 'Q-Q1', customerName: 'Maya', product: 'private', vehicle: 'car', totalCents: 21900, currency: 'USD', status: quote.status,
  }] })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json(who)));
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view .qrow[data-qopen="q1"]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await expect(page.locator('.ch-status-pill')).toHaveText('Booked', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
  return { calls };
}
const bar = (page) => page.locator('.ch-actionbar');
const balanceBtn = (page) => bar(page).locator('[data-action="copyBalanceLink"]');
const copied = (page) => page.evaluate(() => window.__copied);

for (const who of [FOUNDER, OPS]) {
  test(`a won quote with an open balance offers "Balance payment link" — pressing it copies the link (${who.role})`, async ({ page }) => {
    const { calls } = await openQuote(page, wonQuote(), who);

    // ONE button, and it is the whole bar: a won quote with a booking offers nothing else.
    await expect(balanceBtn(page)).toHaveCount(1);
    await expect(balanceBtn(page)).toHaveText('Balance payment link');
    await expect(bar(page).locator('button[data-action]')).toHaveCount(1);

    const before = calls.length;
    await balanceBtn(page).click();
    await expect.poll(() => copied(page)).toEqual([PAY_LINK]);
    await expect(page.locator('#ch-toast')).toHaveClass(/show/);
    await expect(page.locator('#ch-toast .ch-toast-msg')).toHaveText('Balance payment link copied — $169.00 still to pay');
    await expect(page.locator('#ch-toast')).not.toHaveClass(/bad/);
    // The link was read when the quote opened: the press asks the server for nothing.
    expect(calls.slice(before)).toEqual([]);
  });
}

test('a won quote with no open balance has no such button — its bar is as it was', async ({ page }) => {
  await openQuote(page, wonQuote({ balancePayLink: null, balanceCents: null }));
  await expect(balanceBtn(page)).toHaveCount(0);
  await expect(bar(page).locator('button[data-action]')).toHaveCount(0);
});

test('a won quote that never became a booking still offers only "Mark booked"', async ({ page }) => {
  await openQuote(page, wonQuote({ convertedBookingId: null, balancePayLink: null, balanceCents: null }));
  await expect(balanceBtn(page)).toHaveCount(0);
  await expect(bar(page).locator('button[data-action]')).toHaveCount(1);
  await expect(bar(page).locator('[data-action="markWon"]')).toHaveText('Mark booked');
});
