import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// manage.html — add-ons the team added AFTER booking (spec 2026-11-14 §7.4). A request ops sent is
// paid from this page: a pay card above the ticket, the same PayHere hand-off as the trip, a green
// card when it comes back paid, one muted line when it ran out. The trip's own Total and Paid never
// move. Offline: every API call and the gateway are stubbed.

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const PAGE = '/manage.html?t=test-token';

// Computed, never fixed: the web suite rejects calendar dates inside the next 18 months.
const DAY1 = futureIsoDate(20);
const DAY2 = futureIsoDate(24);
const SHORT_DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const short = (iso) => {
  const [y, m, d] = iso.split('-').map(Number);
  return `${SHORT_DAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]} ${d} ${MON3[m - 1]}`;
};

const BOOKING = {
  reference: 'CH-K7M2Q', status: 'paid', mode: 'trip', firstName: 'Anna',
  from: 'Kandy', to: 'Galle', stops: ['Kandy', 'Ella', 'Yala', 'Galle'],
  legDates: [DAY1, null, DAY2], date: DAY1, endDate: DAY2, time: null,
  travellers: 2, vehicleType: 'car', currency: 'USD',
  totalCents: 24000, amountDueNowCents: 24000, balanceDueCents: 0, paidCents: 24000, needsPricing: false,
};
const WAIT = { label: 'Waiting fee — Kandy → Ella', amountCents: 500 };
const SIGHT = { label: 'Sightseeing stops (up to 3h) — Yala → Galle', amountCents: 1000 };
const REQ_A = { id: 'req-a', state: 'awaiting_payment', totalCents: 1500, currency: 'USD', payable: true, payBy: DAY1, lines: [WAIT, SIGHT] };
const REQ_B = { id: 'req-b', state: 'awaiting_payment', totalCents: 700, currency: 'USD', payable: true, payBy: null,
  lines: [{ label: 'Extra luggage — Kandy → Ella', amountCents: 700 }] };

async function offline(page, view) {
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('**/bookings/view?*', (r) => r.fulfill(json(typeof view === 'function' ? view() : view)));
}
const withReqs = (reqs, over = {}) => ({ ...BOOKING, addOnRequests: reqs, ...over });
const money = (c) => `$${(c / 100).toFixed(2)}`;

for (const width of [375, 768, 1280]) {
  test.describe(`at ${width}px`, () => {
    test.use({ viewport: { width, height: 900 } });

    test('a payable request is a card above the ticket: lines, total, button, deadline', async ({ page }) => {
      await offline(page, withReqs([REQ_A]));
      await page.goto(PAGE);
      const card = page.locator('#add-ons');
      await expect(card).toBeVisible();
      await expect(card.locator('h2')).toHaveText('An add-on to pay');
      await expect(card).toContainText('Our team added this to your trip, as you asked. It’s confirmed once it’s paid.');
      await expect(card.locator('.ao-line')).toHaveCount(2);
      await expect(card.locator('.ao-line').nth(0)).toContainText(WAIT.label);
      await expect(card.locator('.ao-line').nth(0)).toContainText('$5.00');
      await expect(card.locator('.ao-line').nth(1)).toContainText(SIGHT.label);
      await expect(card.locator('.ao-line').nth(1)).toContainText('$10.00');
      await expect(card.locator('.ao-total')).toContainText('To pay now');
      await expect(card.locator('.ao-total')).toContainText('$15.00');
      await expect(card.locator('button')).toHaveText('Pay $15.00');
      await expect(card.locator('button')).toHaveClass(/btn-cta/);
      await expect(card.locator('.pk-fine')).toHaveText(`Pay by the end of ${short(DAY1)}. Card payment through PayHere.`);
      // Above the ticket, not inside it.
      const cardBox = await card.boundingBox();
      const ticketBox = await page.locator('.ticket').boundingBox();
      expect(cardBox.y + cardBox.height).toBeLessThanOrEqual(ticketBox.y);
      // The trip's own figures are untouched, and the page does not scroll sideways.
      await expect(page.locator('.tot', { hasText: 'Total' }).locator('.v')).toHaveText('$240.00');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });

    test('two payable requests are two cards and two buttons; only the first is the hash target', async ({ page }) => {
      await offline(page, withReqs([REQ_A, REQ_B]));
      await page.goto(PAGE);
      await expect(page.locator('[data-add-on-card]')).toHaveCount(2);
      await expect(page.locator('[data-add-on-card] button')).toHaveCount(2);
      await expect(page.locator('#add-ons')).toHaveCount(1);
      await expect(page.locator('[data-add-on-card]').first()).toHaveAttribute('id', 'add-ons');
      await expect(page.locator('[data-add-on-card]').nth(1).locator('button')).toHaveText('Pay $7.00');
      // No date on the second request: the deadline sentence is left out, the card sentence stays.
      await expect(page.locator('[data-add-on-card]').nth(1).locator('.pk-fine')).toHaveText('Card payment through PayHere.');
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
    });
  });
}

test('with no add-on requests the page is exactly as before, with or without the field', async ({ page }) => {
  let view = { ...BOOKING };
  await offline(page, () => view);
  await page.goto(PAGE);
  await expect(page.locator('.ticket')).toBeVisible();
  const without = await page.locator('#app').innerHTML();
  view = withReqs([]);
  await page.reload();
  await expect(page.locator('.ticket')).toBeVisible();
  expect(await page.locator('#app').innerHTML()).toBe(without);
  await expect(page.locator('#add-ons')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Add-ons');
});

test('the pay link’s #add-ons scrolls to the card even though it renders after the page loads', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 600 });
  await offline(page, withReqs([REQ_A]));
  await page.goto(PAGE + '#add-ons');
  await expect(page.locator('#add-ons')).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  const top = await page.locator('#add-ons').evaluate((el) => el.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(0);
  expect(top).toBeLessThan(60);
});

test('no hash, no scroll', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 600 });
  await offline(page, withReqs([REQ_A]));
  await page.goto(PAGE);
  await expect(page.locator('#add-ons')).toBeVisible();
  expect(await page.evaluate(() => window.scrollY)).toBe(0);
});

// ── paying ────────────────────────────────────────────────────────────────────────────────────
async function payhere(page) {
  await page.route('https://sandbox.payhere.lk/**', (r) => r.fulfill({ status: 200, contentType: 'text/html', body: '<h1>PayHere stub</h1>' }));
}

test('Pay asks for a token naming the request, then checks out as an add-on; no amount is sent', async ({ page }) => {
  await offline(page, withReqs([REQ_A, REQ_B]));
  await payhere(page);
  const calls = [];
  await page.route('**/bookings/view/checkout-token', (r) => {
    calls.push({ url: 'token', auth: r.request().headers().authorization, body: JSON.parse(r.request().postData() || 'null') });
    return r.fulfill(json({ bookingId: 'b-1', checkoutToken: 'ct-1' }));
  });
  await page.route('**/bookings/b-1/checkout', (r) => {
    calls.push({ url: 'checkout', auth: r.request().headers().authorization, body: JSON.parse(r.request().postData() || 'null') });
    return r.fulfill(json({ checkoutUrl: 'https://sandbox.payhere.lk/pay/checkout',
      fields: { merchant_id: 'm-1', order_id: 'CH-K7M2Q-A2', amount: '7.00', currency: 'USD', hash: 'H' } }));
  });
  await page.goto(PAGE);
  // The SECOND card's button: the request id that goes out is that card's, not the first's.
  await page.locator('[data-add-on-card]').nth(1).locator('button').click();
  await page.waitForURL(/sandbox\.payhere\.lk/);
  expect(calls).toEqual([
    { url: 'token', auth: 'Bearer test-token', body: { addOnRequestId: 'req-b' } },
    { url: 'checkout', auth: 'Bearer ct-1', body: { purpose: 'add_on', addOnRequestId: 'req-b', returnTo: 'manage' } },
  ]);
});

for (const [code, status, bodyOf] of [
  ['add_on_not_payable', 409, { error: 'add_on_not_payable' }],
  ['already_paid', 409, { error: 'already_paid', status: 'paid' }],
]) {
  test(`${code} on the token route re-reads the booking and shows where it stands, never a dead button`, async ({ page }) => {
    let reads = 0;
    // First read: payable. After the refusal: the request has run out (or been paid).
    const after = code === 'already_paid'
      ? withReqs([{ ...REQ_A, state: 'paid', payable: false }])
      : withReqs([{ ...REQ_A, state: 'expired', payable: false }]);
    await offline(page, () => (++reads === 1 ? withReqs([REQ_A]) : after));
    await page.route('**/bookings/view/checkout-token', (r) => r.fulfill(json(bodyOf, status)));
    await page.goto(PAGE);
    await page.locator('#add-ons button').click();
    await expect(page.locator('#add-ons')).toHaveCount(0);
    await expect(page.locator('button', { hasText: /^Pay \$/ })).toHaveCount(0);
    if (code === 'already_paid') {
      await expect(page.locator('.ao-paid-card')).toContainText('Add-on paid');
      await expect(page.locator('.ao-paid')).toContainText('$15.00');
    } else {
      await expect(page.locator('.ao-gone').first()).toHaveText(`${WAIT.label} wasn’t added.`);
    }
    // Said in the page's own words, not an error code.
    await expect(page.locator('body')).not.toContainText(code);
  });
}

test('a checkout refusal (add_on_not_payable) reads the same way', async ({ page }) => {
  let reads = 0;
  await offline(page, () => (++reads === 1 ? withReqs([REQ_A]) : withReqs([{ ...REQ_A, state: 'expired', payable: false }])));
  await page.route('**/bookings/view/checkout-token', (r) => r.fulfill(json({ bookingId: 'b-1', checkoutToken: 'ct-1' })));
  await page.route('**/bookings/b-1/checkout', (r) => r.fulfill(json({ error: 'add_on_not_payable' }, 409)));
  await page.goto(PAGE);
  await page.locator('#add-ons button').click();
  await expect(page.locator('.ao-gone')).toHaveCount(2);
  await expect(page.locator('#add-ons')).toHaveCount(0);
});

test('any other failure leaves the card and says nothing was charged', async ({ page }) => {
  await offline(page, withReqs([REQ_A]));
  await page.route('**/bookings/view/checkout-token', (r) => r.fulfill(json({ error: 'boom' }, 500)));
  await page.goto(PAGE);
  await page.locator('#add-ons button').click();
  await expect(page.locator('#add-ons .pk-err')).toContainText('We couldn’t start your payment just now');
  await expect(page.locator('#add-ons .pk-err')).toContainText('no charge was made');
  await expect(page.locator('#add-ons button')).toHaveText('Pay $15.00');
});

// ── paid, expired ─────────────────────────────────────────────────────────────────────────────
const PAID = { ...REQ_A, state: 'paid', payable: false };

test('a paid request: its own line under the trip total, which does not change', async ({ page }) => {
  await offline(page, withReqs([PAID], { addOns: ['Waiting fee — Kandy → Ella'] }));
  await page.goto(PAGE);
  await expect(page.locator('#add-ons')).toHaveCount(0);
  await expect(page.locator('.tot.ao-paid .l')).toHaveText('Add-ons · paid');
  await expect(page.locator('.tot.ao-paid .v')).toHaveText('$15.00');
  await expect(page.locator('.tot', { hasText: /^Total/ }).locator('.v')).toHaveText('$240.00');
  await expect(page.locator('.tot.due')).toHaveCount(0);
});

test('an expired request is one muted line per add-on, no button, no charge', async ({ page }) => {
  await offline(page, withReqs([{ ...REQ_A, state: 'expired', payable: false }]));
  await page.goto(PAGE);
  await expect(page.locator('.ao-gone')).toHaveCount(2);
  await expect(page.locator('.ao-gone').nth(0)).toHaveText(`${WAIT.label} wasn’t added.`);
  await expect(page.locator('.ao-gone').nth(1)).toHaveText(`${SIGHT.label} wasn’t added.`);
  await expect(page.locator('button', { hasText: /^Pay/ })).toHaveCount(0);
  await expect(page.locator('.ao-paid')).toHaveCount(0);
});

test('a refunded or cancelled-with-booking request adds nothing to the page', async ({ page }) => {
  await offline(page, withReqs([
    { ...REQ_A, state: 'refunded', payable: false },
    { ...REQ_B, state: 'cancelled_with_booking', payable: false },
  ]));
  await page.goto(PAGE);
  await expect(page.locator('.ticket')).toBeVisible();
  await expect(page.locator('.pk, .ao-gone, .ao-paid')).toHaveCount(0);
});

// ── the return leg ────────────────────────────────────────────────────────────────────────────
const RETURN = '/manage.html?t=test-token&rt=return-token-1';
const returns = (page, answer) => page.route('**/bookings/pay-return?rt=*', (r) => r.fulfill(json(answer)));

test('coming back paid shows the green card naming the add-on, the paid line, and no purchase event', async ({ page }) => {
  // chIsProd and the gateway's own `sandbox:false` are both true: only the add-on lets this skip.
  await page.addInitScript(() => { Object.defineProperty(window, 'chIsProd', { get: () => () => true, set() {}, configurable: true }); });
  await offline(page, withReqs([PAID]));
  await returns(page, { status: 'paid', reference: 'CH-K7M2Q', sandbox: false, addOnRequestId: 'req-a' });
  await page.goto(RETURN);
  const card = page.locator('.ao-paid-card');
  await expect(card).toBeVisible();
  await expect(card.locator('h2')).toHaveText('Add-on paid');
  await expect(card).toContainText(WAIT.label);
  await expect(card).toContainText(SIGHT.label);
  await expect(card).toContainText('We’ve emailed your receipt for $15.00.');
  await expect(page.locator('#add-ons')).toHaveCount(0);
  await expect(page.locator('.tot.ao-paid .v')).toHaveText('$15.00');
  const events = await page.evaluate(() => (window.dataLayer || []).map((e) => e && e.event));
  expect(events).not.toContain('purchase');
  expect(page.url()).not.toContain('rt=');
});

test('control: the same return WITHOUT an add-on id still fires the trip’s purchase', async ({ page }) => {
  await page.addInitScript(() => { Object.defineProperty(window, 'chIsProd', { get: () => () => true, set() {}, configurable: true }); });
  await offline(page, { ...BOOKING, addOnRequests: [], status: 'paid' });
  await returns(page, { status: 'paid', reference: 'CH-K7M2Q', sandbox: false });
  await page.goto(RETURN);
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  const events = await page.evaluate(() => (window.dataLayer || []).map((e) => e && e.event));
  expect(events).toContain('purchase');
});

test('a cancelled add-on payment is about the ADD-ON, and the card is still there to pay', async ({ page }) => {
  await offline(page, withReqs([REQ_A]));
  await returns(page, { status: 'failed', reference: 'CH-K7M2Q', addOnRequestId: 'req-a' });
  await page.goto(RETURN + '&c=1');
  const card = page.locator('#add-ons');
  await expect(card).toBeVisible();
  await expect(card.locator('.pk-err')).toContainText('The add-on payment didn’t go through');
  await expect(card.locator('.pk-err')).toContainText('no charge was made');
  await expect(card.locator('button')).toHaveText('Pay $15.00');
  await expect(page.locator('body')).not.toContainText('Your payment');
  // The trip's own pay machinery is not on this page.
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('#payerr')).toHaveCount(0);
});

test('still pending when polling gives up: honest about the add-on, card kept, trip not blamed', async ({ page }) => {
  await page.clock.install();
  await offline(page, withReqs([REQ_A]));
  let polls = 0;
  await page.route('**/bookings/pay-return?rt=*', (r) => { polls++; return r.fulfill(json({ status: 'pending', reference: 'CH-K7M2Q', addOnRequestId: 'req-a' })); });
  await page.goto(RETURN + '&c=1');
  for (let i = 0; i < 20 && polls < 8; i++) { await page.clock.runFor(2100); await page.waitForTimeout(30); }
  const err = page.locator('#add-ons .pk-err');
  await expect(err).toContainText('We haven’t heard back from your bank about the add-on payment.');
  await expect(err).toContainText('If PayHere showed Declined, nothing was charged');
  await expect(page.locator('#add-ons button')).toHaveText('Pay $15.00');
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('body')).not.toContainText('Confirming your payment');
});

test('a return that has no manage token in this tab still works and says it was the add-on', async ({ page }) => {
  await offline(page, withReqs([PAID]));
  await returns(page, { status: 'paid', reference: 'CH-K7M2Q', sandbox: false, addOnRequestId: 'req-a' });
  await page.goto('/manage.html?rt=return-token-1');
  await expect(page.locator('.st-title')).toHaveText('Add-on paid');
  await expect(page.locator('body')).not.toContainText('You’re booked');
});
