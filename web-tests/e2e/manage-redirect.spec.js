import { test, expect } from '@playwright/test';

// manage.html's checkout — the page the watchdog's "Finish your booking" email and the ops
// drawer's payment link send a customer to. On 2026-09-24 PayHere's decline list showed two silent
// failures as "3ds Authentication Failed" with no notify ever reaching us: the 3-D Secure challenge
// dying inside the SDK's cross-origin iframe (docs/checkout-redirect-spec.md §1.4). This page now
// hands off with the same top-level form POST pay.html uses, and on the way back asks OUR server
// what happened. Offline: every API call and the gateway are stubbed.

test.describe.configure({ mode: 'serial' });

const BOOKING = {
  reference: 'CH-HAFDZ', status: 'payment_pending', firstName: 'Roshen',
  from: 'Colombo Airport (CMB)', to: 'Batticaloa, Sri Lanka', date: '2026-07-22', time: null,
  travellers: 2, vehicleType: 'car', totalCents: 22900, balanceDueCents: 0,
  amountDueNowCents: 22900, currency: 'USD',
};

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

async function offline(page, view = BOOKING) {
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  // The SDK must not be requested at all. Counted, not stubbed, so a re-added <script> fails here.
  const sdk = [];
  await page.route('https://www.payhere.lk/lib/**', (r) => { sdk.push(r.request().url()); return r.abort(); });
  await page.route('**/bookings/view?*', (r) => r.fulfill(json(view)));
  return sdk;
}

test('paying hands off with a top-level form POST carrying the server’s fields verbatim', async ({ page }) => {
  const sdk = await offline(page);
  await page.route('**/bookings/view/checkout-token', (r) => r.fulfill(json({ bookingId: 'b-1', checkoutToken: 'ct-1' })));
  let checkoutBody;
  await page.route('**/bookings/b-1/checkout', async (r) => {
    checkoutBody = JSON.parse(r.request().postData() || 'null');
    await r.fulfill(json({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
      fields: { merchant_id: 'm-1', return_url: 'https://x.test/manage.html?t=a&rt=b', order_id: 'CH-HAFDZ',
        amount: '229.00', currency: 'USD', hash: 'HASHVALUE' } }));
  });
  let posted = null;
  let method = null;
  await page.route('https://sandbox.payhere.lk/**', async (r) => {
    method = r.request().method();
    posted = r.request().postData();
    await r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' });
  });

  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('#paybtn')).toBeVisible();
  expect(await page.evaluate(() => typeof window.payhere)).toBe('undefined');
  await page.locator('#paybtn').click();

  // The customer LEFT our origin — not a modal over it, not an iframe inside it.
  await page.waitForURL(/sandbox\.payhere\.lk/);
  await expect(page.locator('h1')).toHaveText('PayHere stub');
  expect(method).toBe('POST');
  // Intent, never a URL — the server builds the return address.
  expect(checkoutBody).toEqual({ returnTo: 'manage' });
  // Every field, verbatim and in the server's order.
  expect(posted).toBe(new URLSearchParams({ merchant_id: 'm-1', return_url: 'https://x.test/manage.html?t=a&rt=b',
    order_id: 'CH-HAFDZ', amount: '229.00', currency: 'USD', hash: 'HASHVALUE' }).toString());
  expect(sdk).toEqual([]);
});

// The return URL carries only the status token now (review of #774, finding 3): the manage token
// crosses the round trip in this tab's sessionStorage, stashed again right before the hand-off.
test('a manage-link round trip rebuilds the booking from the stashed token, not the URL', async ({ page }) => {
  await offline(page);
  const viewTokens = [];
  await page.route('**/bookings/view?*', (r) => {
    viewTokens.push(new URL(r.request().url()).searchParams.get('t'));
    return r.fulfill(json(viewTokens.length > 1 ? { ...BOOKING, status: 'paid' } : BOOKING));
  });
  await page.route('**/bookings/view/checkout-token', (r) => r.fulfill(json({ bookingId: 'b-1', checkoutToken: 'ct-1' })));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill(json({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
    fields: { merchant_id: 'm-1', return_url: 'http://x.test/manage.html?rt=b', order_id: 'CH-HAFDZ', hash: 'H' } })));
  await page.route('https://sandbox.payhere.lk/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' }));
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'paid', reference: 'CH-HAFDZ' })));

  await page.goto('/manage.html?t=test-token');
  await expect(page.locator('#paybtn')).toBeVisible();
  // Whatever happened to the load-time stash, the hand-off writes it again.
  await page.evaluate(() => sessionStorage.removeItem(window.CH_MANAGE_TOKEN_KEY));
  await page.locator('#paybtn').click();
  await page.waitForURL(/sandbox\.payhere\.lk/);

  await page.goto('/manage.html?rt=return-token-1');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  expect(viewTokens).toEqual(['test-token', 'test-token']);
});

test('coming back paid asks our server, then shows the booking confirmed', async ({ page }) => {
  await offline(page, { ...BOOKING, status: 'paid' });
  let polls = 0;
  await page.route('**/bookings/pay-return?rt=*', (r) => { polls++; return r.fulfill(json({ status: 'paid', reference: 'CH-HAFDZ' })); });
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  expect(polls).toBeGreaterThan(0);
  // Both tokens leave the address bar once read.
  expect(page.url()).not.toContain('rt=');
  expect(page.url()).not.toContain('test-token');
});

test('coming back declined shows the decline help and lets them pay again', async ({ page }) => {
  await offline(page);
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'failed', reference: 'CH-HAFDZ' })));
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('#payerr')).toContainText('didn’t go through');
  await expect(page.locator('#payhelp')).toBeVisible();
  await expect(page.locator('#payhelp h3')).toContainText('declined');
  await expect(page.locator('#payhelp li')).toHaveCount(4);
  await expect(page.locator('#payhelp')).toContainText('banking app');
  await expect(page.locator('#paybtn')).toBeVisible();
  expect(page.url()).not.toContain('rt=');
});

test('a webhook that has not landed yet keeps confirming rather than claiming an outcome', async ({ page }) => {
  await offline(page);
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'pending', reference: 'CH-HAFDZ' })));
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('.st-title')).toHaveText('Confirming your payment…');
  await expect(page.locator('#payhelp')).toHaveCount(0);
});

// The poll budget runs out with no verdict. PayHere sends NO notify for a "3ds Authentication
// Failed" decline (review of #774), so after one of those our server keeps answering `pending` for
// ever — and "awaiting confirmation" read to a declined customer as "it worked, wait". The copy says
// both things it can honestly say, the decline steps are OPEN, and the tell-us link is there — on
// both legs. Still no outcome claimed: no `payment_failed`, no purchase. Driven on a fake clock —
// the real budget is a minute.
const NO_VERDICT = [
  'We haven’t heard back from your bank.',
  'If PayHere showed Declined, nothing was charged — you can try again below.',
  'If it showed Approved, your confirmation email is on its way.',
];

async function runOutTheBudget(page, polls, budget) {
  for (let i = 0; i < budget + 10 && polls() < budget; i++) {
    await page.clock.runFor(2100);
    await page.waitForTimeout(30);
  }
}

test('still pending after the poll budget says both honest things, opens the decline help, offers the link', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  let polls = 0;
  await page.route('**/bookings/pay-return?rt=*', (r) => { polls++; return r.fulfill(json({ status: 'pending', reference: 'CH-HAFDZ' })); });
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('.st-title')).toHaveText('Confirming your payment…');
  await runOutTheBudget(page, () => polls, 30);
  for (const line of NO_VERDICT) await expect(page.locator('#payerr')).toContainText(line);
  await expect(page.locator('#payerr')).not.toContainText('haven’t had confirmation yet');
  // The steps are shown, not tucked behind a summary.
  await expect(page.locator('#payhelp')).toBeVisible();
  await expect(page.locator('#payhelp h3')).toContainText('declined');
  await expect(page.locator('#payhelp .pp-quiet')).toHaveCount(0);
  await expect(page.locator('#payhelp li')).toHaveCount(4);
  await expectTellUsLink(page);
  await expect(page.locator('#paybtn')).toBeVisible();
});

test('Back to Site (cancel leg) that never hears back says the same, with the help open and the link', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  let polls = 0;
  await page.route('**/bookings/pay-return?rt=*', (r) => { polls++; return r.fulfill(json({ status: 'pending', reference: 'CH-HAFDZ' })); });
  await page.goto('/manage.html?t=test-token&rt=return-token-1&c=1');
  await runOutTheBudget(page, () => polls, 8);
  for (const line of NO_VERDICT) await expect(page.locator('#payerr')).toContainText(line);
  await expect(page.locator('#payhelp h3')).toContainText('declined');
  await expect(page.locator('#payhelp .pp-quiet')).toHaveCount(0);
  await expectTellUsLink(page);
  await expect(page.locator('#paybtn')).toBeVisible();
  expect(page.url()).not.toContain('c=1');
});

// No manage token in this tab (storage blocked, a different browser): the booking cannot be
// rebuilt, so the same words stand alone — with the link, since nothing else on screen can help.
test('with no booking to rebuild, the still-waiting screen says both things and offers the link', async ({ page }) => {
  await page.clock.install();
  await offline(page);
  let polls = 0;
  await page.route('**/bookings/pay-return?rt=*', (r) => { polls++; return r.fulfill(json({ status: 'pending', reference: 'CH-HAFDZ' })); });
  await page.goto('/manage.html?rt=return-token-1');
  await runOutTheBudget(page, () => polls, 30);
  await expect(page.locator('.st-sub').first()).toContainText('We haven’t heard back from your bank.');
  await expect(page.locator('.st-wrap')).toContainText('If PayHere showed Declined, nothing was charged');
  await expect(page.locator('.st-wrap')).toContainText('If it showed Approved, your confirmation email is on its way.');
  await expectTellUsLink(page);
});

// ── "Tell us what happened on WhatsApp" (the website overlay's link, #766) ──────────────────────
// Since 2026-09-24 a website payment that fails at PayHere is answered HERE, not in booking.html's
// overlay — so the one-tap link whose prefilled message names the booking comes here too. Only on
// the two states that mean "it didn't work": a decline, and the cancel leg. Never on paid.
const WA_PREFIX = 'https://wa.me/94779669662?text=';
const WA_TEXT = 'Hi Ceylon Hop, my payment for booking CH-HAFDZ didn\'t go through. What I saw: ';

async function expectTellUsLink(page) {
  const a = page.locator('#paywa');
  await expect(a).toBeVisible();
  await expect(a).toHaveText('Tell us what happened on WhatsApp');
  await expect(a).toHaveAttribute('target', '_blank');
  await expect(a).toHaveAttribute('rel', /noopener/);
  const href = await a.getAttribute('href');
  expect(href).toBe(WA_PREFIX + encodeURIComponent(WA_TEXT));
  expect(decodeURIComponent(href.slice(WA_PREFIX.length))).toBe(WA_TEXT);
}

test('a declined return offers the prefilled WhatsApp link, naming the booking', async ({ page }) => {
  await offline(page);
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'failed', reference: 'CH-HAFDZ' })));
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('#payerr')).toContainText('didn’t go through');
  await expectTellUsLink(page);
});

test('the cancel leg offers it too, once the check comes back empty', async ({ page }) => {
  await offline(page);
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'pending', reference: 'CH-HAFDZ' })));
  await page.goto('/manage.html?t=test-token&rt=return-token-1&c=1');
  // While we are still checking with the bank, nothing has gone wrong yet.
  await expect(page.locator('#payerr')).toContainText('nothing has been charged', { timeout: 8000 });
  await expect(page.locator('#paywa')).toBeHidden();
  await expect(page.locator('#payerr')).toContainText('haven’t heard back from your bank', { timeout: 30000 });
  await expectTellUsLink(page);
});

test('a paid return shows no such link', async ({ page }) => {
  await offline(page, { ...BOOKING, status: 'paid' });
  await page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json({ status: 'paid', reference: 'CH-HAFDZ' })));
  await page.goto('/manage.html?t=test-token&rt=return-token-1');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('#paywa')).toHaveCount(0);
  await expect(page.locator('a[href*="didn"]')).toHaveCount(0);
});
