import { test, expect } from '@playwright/test';

// pay.html — the customer's deposit-or-full choice (spec 2026-10-07 §5.2). Offline: every
// /quotes/pay/* and /bookings/* call is stubbed. A link with no `deposit` in /view is the page
// exactly as it was (the rest of pay-page.spec.js is the regression guard for that lane).

test.describe.configure({ mode: 'serial' });

const PAGE = '/pay.html?t=test-token';
const COPY = {
  product: 'single', greetingName: 'Emma', title: 'Colombo Airport (CMB) → Galle',
  subtitle: 'Saturday 8 August 2026', facts: [{ k: 'Travellers', v: '2' }], legs: null,
  includedText: 'Driver, fuel and highway tolls.', totalLabel: 'Total',
};
const TOTALS = { cents: 21900, usd: '$219.00' };
const DEPOSIT = { cents: 5000, usd: '$50.00', balanceCents: 16900, balanceUsd: '$169.00' };
const PREFILL = { firstName: 'Nimal', lastName: 'Perera', email: 'nimal@example.com', whatsapp: '+94770001111', country: '' };

async function stubView(page, extra) {
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'payable', copy: COPY, totals: TOTALS, prefill: PREFILL, ...extra }) }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/lib/**', (r) => r.abort());
}

async function fillAndContinue(page) {
  await page.locator('#paybtn').click();
  await page.locator('#f-addr').fill('Prinsengracht 263');
  await page.locator('#f-city').fill('Amsterdam');
  await page.locator('#f-bcountry').selectOption('Netherlands');
  await page.locator('#f-terms').check();
  await page.locator('#gobtn').click();
}

test('an eligible link shows both options, full pre-selected', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  await page.goto(PAGE);
  await expect(page.locator('.pay-opt')).toHaveCount(2);
  await expect(page.locator('.pay-opt').nth(0)).toContainText('Pay in full');
  await expect(page.locator('.pay-opt').nth(0)).toContainText('$219.00');
  await expect(page.locator('.pay-opt').nth(1)).toContainText('Pay a deposit');
  await expect(page.locator('.pay-opt').nth(1)).toContainText('$50.00');
  await expect(page.locator('.pay-opt').nth(1)).toContainText('balance $169.00 any time before your trip');
  await expect(page.locator('input[name=paychoice][value=full]')).toBeChecked();
  await expect(page.locator('#paybtn')).toHaveText('Pay $219.00 with PayHere');
  await expect(page.locator('.tot .v')).toHaveText('$219.00'); // the trip total stays the trip total
});

test('no deposit in /view: no options, today’s button and line', async ({ page }) => {
  await stubView(page, {});
  await page.goto(PAGE);
  await expect(page.locator('.pay-opt')).toHaveCount(0);
  await expect(page.locator('#paybtn')).toHaveText('Pay with PayHere');
  await expect(page.locator('.paysub')).toContainText('Pay securely to confirm. $219.00 — no extra fees.');
});

test('choosing the deposit retitles the button and the line, and /start carries payment:"deposit"', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  let started = null;
  await page.route('**/quotes/pay/start', async (r) => {
    started = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', message: 'stop here' }) });
  });
  await page.goto(PAGE);
  await page.locator('input[name=paychoice][value=deposit]').check();
  await expect(page.locator('#paybtn')).toHaveText('Pay $50.00 deposit with PayHere');
  await expect(page.locator('.paysub')).toContainText('$50.00 now');
  await fillAndContinue(page);
  await expect.poll(() => started?.payment).toBe('deposit');
});

test('leaving full selected posts payment:"full"', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  let started = null;
  await page.route('**/quotes/pay/start', async (r) => {
    started = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', message: 'stop here' }) });
  });
  await page.goto(PAGE);
  await fillAndContinue(page);
  await expect.poll(() => started?.payment).toBe('full');
});

test('a link with no deposit posts exactly today’s body — no payment key', async ({ page }) => {
  await stubView(page, {});
  let started = null;
  await page.route('**/quotes/pay/start', async (r) => {
    started = JSON.parse(r.request().postData());
    await r.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'bad_request', message: 'stop here' }) });
  });
  await page.goto(PAGE);
  await fillAndContinue(page);
  await expect.poll(() => started !== null).toBe(true);
  expect(started).not.toHaveProperty('payment');
});

test('the choice survives to the details step, where it can still be changed', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  await page.goto(PAGE);
  await page.locator('input[name=paychoice][value=deposit]').check();
  await page.locator('#paybtn').click();
  await expect(page.locator('input[name=paychoice][value=deposit]')).toBeChecked();
  await page.locator('input[name=paychoice][value=full]').check();
  await expect(page.locator('input[name=paychoice][value=full]')).toBeChecked();
});

test('the browser purchase reports the DEPOSIT that was charged, not the trip total', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  // The purchase gate needs a real host. analytics.js assigns window.chIsProd itself, so pin it with
  // an accessor that ignores that assignment (the sandbox-gateway gate is separate and stays honest).
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chIsProd', { get: () => () => true, set: () => {}, configurable: true });
  });
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 201, contentType: 'application/json',
    body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1', ga4Item: { item_id: 'x', item_name: 'x' } }) }));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ checkoutUrl: 'https://www.payhere.lk/pay/checkout',
      fields: { order_id: 'o-1-D', merchant_id: 'm-1', amount: '50.00', hash: 'H' } }) }));
  await page.route('https://www.payhere.lk/pay/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' }));
  await page.goto(PAGE);
  await page.locator('input[name=paychoice][value=deposit]').check();
  await fillAndContinue(page);
  await page.waitForURL(/payhere\.lk/);

  // The return leg: a settled payment, the page's own stash, no re-fetch of /view before purchase.
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'paid', reference: 'CH-DEP01', sandbox: false }) }));
  await page.goto('/pay.html?rt=any-token');
  await expect.poll(() => page.evaluate(() => (window.dataLayer || []).filter((e) => e && e.event === 'purchase').length)).toBe(1);
  const purchase = await page.evaluate(() => (window.dataLayer || []).find((e) => e && e.event === 'purchase'));
  expect(purchase.value).toBe(50);
  expect(purchase.transaction_id).toBe('CH-DEP01');
});

test('a deposit refused as ineligible drops the offer and re-reads the link', async ({ page }) => {
  let views = 0;
  await page.route('**/quotes/pay/view*', (r) => {
    views += 1;
    // The quote changed under the payer: the second read no longer offers a deposit.
    return r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ state: 'payable', copy: COPY, totals: TOTALS, prefill: PREFILL, ...(views === 1 ? { deposit: DEPOSIT } : {}) }) });
  });
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'deposit_ineligible' }) }));
  await page.goto(PAGE);
  await page.locator('input[name=paychoice][value=deposit]').check();
  await fillAndContinue(page);
  await expect(page.locator('#paybtn')).toHaveText('Pay with PayHere');
  await expect(page.locator('.pay-opt')).toHaveCount(0);
});

test('the browser purchase reports the amount the SERVER charged when it disagrees with the page’s choice', async ({ page }) => {
  await stubView(page, { deposit: DEPOSIT });
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chIsProd', { get: () => () => true, set: () => {}, configurable: true });
  });
  await page.route('**/quotes/pay/start', (r) => r.fulfill({ status: 201, contentType: 'application/json',
    body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1', ga4Item: { item_id: 'x', item_name: 'x' } }) }));
  // The page chose the DEPOSIT, but the booking was switched to full underneath it: the checkout
  // charges 219.00 (minor units on `amount`). The purchase must say what was charged.
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ amount: 21900, checkoutUrl: 'https://www.payhere.lk/pay/checkout',
      fields: { order_id: 'o-1', merchant_id: 'm-1', amount: '219.00', hash: 'H' } }) }));
  await page.route('https://www.payhere.lk/pay/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' }));
  await page.goto(PAGE);
  await page.locator('input[name=paychoice][value=deposit]').check();
  await fillAndContinue(page);
  await page.waitForURL(/payhere\.lk/);
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'paid', reference: 'CH-SRV01', sandbox: false }) }));
  await page.goto('/pay.html?rt=any-token');
  await expect.poll(() => page.evaluate(() => (window.dataLayer || []).filter((e) => e && e.event === 'purchase').length)).toBe(1);
  const purchase = await page.evaluate(() => (window.dataLayer || []).find((e) => e && e.event === 'purchase'));
  expect(purchase.value).toBe(219);
});
