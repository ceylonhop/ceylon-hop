import { test, expect } from '@playwright/test';

// pay.html — the balance of a deposit booking, on the same link (spec 2026-10-07 §5.3). Offline:
// every /quotes/pay/* and /bookings/* call is stubbed.

test.describe.configure({ mode: 'serial' });

const PAGE = '/pay.html?t=test-token';
const BALANCE = {
  title: 'Colombo Airport (CMB) → Galle', totalUsd: '$219.00', paidUsd: '$50.00',
  paidOn: '2026-10-05', balanceCents: 16900, balanceUsd: '$169.00',
};

async function stubBalanceView(page, body = { state: 'balance', balance: BALANCE }) {
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/lib/**', (r) => r.abort());
}

async function stubHandOff(page) {
  const seen = { balance: null, checkout: null, auth: null };
  await page.route('**/quotes/pay/balance', async (r) => {
    seen.balance = JSON.parse(r.request().postData());
    await r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1' }) });
  });
  await page.route('**/bookings/b-1/checkout', async (r) => {
    seen.checkout = JSON.parse(r.request().postData());
    seen.auth = r.request().headers()['authorization'];
    await r.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ checkoutUrl: 'https://www.payhere.lk/pay/checkout',
        fields: { order_id: 'CH-ABC12-B', merchant_id: 'm-1', amount: '169.00', hash: 'H' } }) });
  });
  await page.route('https://www.payhere.lk/pay/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' }));
  return seen;
}

test('the balance state shows the trip, what is paid, what is left, and one Pay balance button', async ({ page }) => {
  await stubBalanceView(page);
  await page.goto(PAGE);
  await expect(page.locator('.pp-title')).toHaveText('Colombo Airport (CMB) → Galle');
  await expect(page.locator('.t-stub')).toContainText('Paid');
  await expect(page.locator('.t-stub')).toContainText('$50.00');
  await expect(page.locator('.t-stub')).toContainText('Balance');
  await expect(page.locator('.t-stub')).toContainText('$169.00');
  await expect(page.locator('.included')).toContainText('paid on 5 Oct 2026');
  await expect(page.locator('#paybtn')).toHaveText('Pay balance');
  // No contact form, no terms checkbox, no deposit/full choice.
  await expect(page.locator('#f-terms')).toHaveCount(0);
  await expect(page.locator('#f-addr')).toHaveCount(0);
  await expect(page.locator('.pay-opt')).toHaveCount(0);
});

test('Pay balance posts /quotes/pay/balance, then the checkout with purpose:"balance" and the pay-link return', async ({ page }) => {
  await stubBalanceView(page);
  const seen = await stubHandOff(page);
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.waitForURL(/payhere\.lk/);
  expect(seen.balance).toEqual({ t: 'test-token' });
  expect(seen.auth).toBe('Bearer ct-1');
  expect(seen.checkout).toMatchObject({ purpose: 'balance', returnTo: 'pay-link' });
  expect(seen.checkout).not.toHaveProperty('amount');
});

test('the hand-off screen names the balance, not the trip total', async ({ page }) => {
  await stubBalanceView(page);
  await page.route('**/quotes/pay/balance', () => { /* hang: stay on the hand-off screen */ });
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('.pp-expect .amt2')).toHaveText('$169.00');
});

test('the return leg of a balance payment sends NO browser purchase', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(window, 'chIsProd', { get: () => () => true, set: () => {}, configurable: true });
  });
  await stubBalanceView(page);
  await stubHandOff(page);
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await page.waitForURL(/payhere\.lk/);
  await page.route('**/bookings/pay-return*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ status: 'paid', reference: 'CH-ABC12', sandbox: false }) }));
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: { reference: 'CH-ABC12', firstName: 'Nimal', amountUsd: '$219.00', title: 'Colombo Airport (CMB) → Galle' } }) }));
  await page.goto('/pay.html?rt=any-token');
  await expect(page.locator('.st-title')).toContainText('You’re booked');
  const purchases = await page.evaluate(() => (window.dataLayer || []).filter((e) => e && e.event === 'purchase').length);
  expect(purchases).toBe(0);
});

test('a balance that was settled in another tab falls back to what the link says now', async ({ page }) => {
  await stubBalanceView(page);
  await page.route('**/quotes/pay/balance', (r) => r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'no_balance_due' }) }));
  await page.goto(PAGE);
  await page.route('**/quotes/pay/view*', (r) => r.fulfill({ status: 200, contentType: 'application/json',
    body: JSON.stringify({ state: 'paid', paid: { reference: 'CH-ABC12', firstName: 'Nimal', amountUsd: '$219.00', title: 'Colombo Airport (CMB) → Galle' } }) }));
  await page.locator('#paybtn').click();
  await expect(page.locator('.st-title')).toContainText('You’re booked');
});

test('a refused checkout puts the balance view back with the error, not a contact form', async ({ page }) => {
  await stubBalanceView(page);
  await page.route('**/quotes/pay/balance', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ bookingId: 'b-1', checkoutToken: 'ct-1' }) }));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill({ status: 500, contentType: 'application/json', body: '{}' }));
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('#payerr')).toBeVisible();
  await expect(page.locator('#paybtn')).toHaveText('Pay balance');
  await expect(page.locator('#f-terms')).toHaveCount(0);
});
