import { test, expect } from '@playwright/test';

// manage.html — "your booking", reached from a confirmation email or the ops booking drawer's
// payment link. It shipped before the pay-ticket design existed and never got the pass, so a
// customer following a booking link landed somewhere that looked nothing like the page that
// was signed off (owner, 2026-07-31). These specs pin the design it now shares with pay.html
// AND the customer-language rules. Offline: /bookings/view is stubbed.

test.describe.configure({ mode: 'serial' });

const PAGE = '/manage.html?t=test-token';

const BOOKING = {
  reference: 'CH-HAFDZ',
  status: 'payment_pending',
  mode: 'single',
  firstName: 'Roshen',
  from: 'Colombo Airport (CMB)',
  to: 'Batticaloa, Sri Lanka',
  date: '2026-07-22',
  time: null,
  travellers: 2,
  vehicleType: 'car',
  totalCents: 22900,
  balanceDueCents: 0,
  amountDueNowCents: 22900,
  currency: 'USD',
};

async function stub(page, booking) {
  await page.route('**/bookings/view*', (r) =>
    r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(booking) }));
  await page.route('https://www.googletagmanager.com/**', (r) => r.fulfill({ status: 200, body: '' }));
  await page.route('https://www.payhere.lk/**', (r) =>
    r.fulfill({ status: 200, contentType: 'application/javascript', body: 'window.payhere={startPayment:function(){}};' }));
}

test('wears the same travel document as the pay page', async ({ page }) => {
  await stub(page, BOOKING);
  await page.goto(PAGE);
  // The real logo file, not a wordmark on its own — the header is pay.html's verbatim.
  await expect(page.locator('.pp-cmark')).toHaveAttribute('src', 'img/brand-c.svg');
  await expect(page.locator('.pp-hello')).toHaveText('Hi Roshen,');
  await expect(page.locator('.pp-title')).toHaveText('Colombo Airport (CMB) → Batticaloa, Sri Lanka');
  await expect(page.locator('.ticket')).toBeVisible();
  await expect(page.locator('.t-ref')).toHaveText('Booking CH-HAFDZ');
});

test('speaks to the customer, never in database values', async ({ page }) => {
  await stub(page, BOOKING);
  await page.goto(PAGE);
  const body = page.locator('body');
  await expect(body).not.toContainText('payment_pending'); // the bug: a raw enum shown to a traveller
  await expect(page.locator('.t-stat')).toHaveText('Awaiting payment');
  await expect(page.locator('.pp-sub')).toHaveText('Wednesday 22 July 2026'); // not 2026-07-22
  await expect(body).not.toContainText('2026-07-22');
  // Selected by LABEL, not row index: the card grew Trip start / Trip end / Stops rows
  // (owner, 2026-07-31) and index-pinned assertions broke without the copy being any worse.
  await expect(page.locator('.fact', { hasText: 'Vehicle' })).toContainText('Private car'); // not lowercase "car"
  await expect(page.locator('.fact', { hasText: 'Landing time' })).toContainText('To be confirmed');
  // The added rows must speak the same way — human dates, never the raw ISO the API sent.
  await expect(page.locator('.fact', { hasText: 'Trip start' })).toContainText('22 July 2026');
  await expect(page.locator('.fact', { hasText: 'Stops' })).toContainText('2 stops');
});

test('money reads as a price, and a zero balance earns no row', async ({ page }) => {
  await stub(page, BOOKING);
  await page.goto(PAGE);
  await expect(page.locator('.tot .v').first()).toHaveText('$229.00'); // not "USD 229"
  await expect(page.locator('.tot.due')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Balance due');
});

test('an outstanding balance does get its own row', async ({ page }) => {
  await stub(page, { ...BOOKING, balanceDueCents: 10000, amountDueNowCents: 10000 });
  await page.goto(PAGE);
  await expect(page.locator('.tot.due')).toContainText('Balance due');
  await expect(page.locator('.tot.due .v')).toHaveText('$100.00');
});

// A promo-code booking names the code and what it took off, right above the (lower) Total — the
// view carries promoCode + discountCents only then (projectBooking).
test('a promo code gets its own row above Total', async ({ page }) => {
  await stub(page, { ...BOOKING, totalCents: 20610, amountDueNowCents: 20610, promoCode: 'SUMMER-15', discountCents: 2290 });
  await page.goto(PAGE);
  await expect(page.locator('.tot-disc .l')).toHaveText('Promo SUMMER-15');
  await expect(page.locator('.tot-disc .v')).toHaveText('−$22.90');
  await expect(page.locator('.tot-final .l')).toHaveText('Total');
  await expect(page.locator('.tot-final .v')).toHaveText('$206.10');
});

test('no promo row without a code', async ({ page }) => {
  await stub(page, BOOKING);
  await page.goto(PAGE);
  await expect(page.locator('.ticket')).toBeVisible();
  await expect(page.locator('.tot-disc')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Promo');
});

test('the pay button is the approved one, with the same reassurance line', async ({ page }) => {
  await stub(page, BOOKING);
  await page.goto(PAGE);
  await expect(page.locator('#paybtn')).toHaveText('Pay with PayHere');
  await expect(page.locator('#paybtn')).toHaveClass(/btn-cta/);
  await expect(page.locator('.paysub')).toContainText('Pay securely to confirm. $229.00 — no extra fees.');
});

test('a settled booking is confirmed, and offers no way to pay again', async ({ page }) => {
  await stub(page, { ...BOOKING, status: 'paid', balanceDueCents: 0, amountDueNowCents: 0 });
  await page.goto(PAGE);
  await expect(page.locator('.t-stat')).toHaveText('Confirmed');
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('Balance due');
});

test('a broken link fails softly, in the shared state style', async ({ page }) => {
  await page.route('**/bookings/view*', (r) =>
    r.fulfill({ status: 401, contentType: 'application/json', body: '{}' }));
  await page.goto(PAGE);
  await expect(page.locator('.st-title')).toHaveText('We couldn’t open this booking');
  await expect(page.locator('body')).toContainText('WhatsApp');
});

// A booking the server couldn't price (a bare hotel name it couldn't place) carries a flat
// placeholder total — $40/$50 a leg — that checkout refuses with 409. The card used to show that
// placeholder with an enabled Pay button, and pressing it said "already paid or closed". The view
// now says needsPricing, and the card says what is really happening instead.
const HAND_PRICE = 'We’re confirming the price for this trip by hand — we’ll message you on WhatsApp with a payment link.';
const UNPRICED = { ...BOOKING, status: 'draft', needsPricing: true, totalCents: 4000, amountDueNowCents: 4000 };

test('a booking awaiting a hand price offers no Pay and no placeholder amount', async ({ page }) => {
  await stub(page, UNPRICED);
  await page.goto(PAGE);
  await expect(page.locator('.ticket')).toBeVisible();
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('.tot')).toHaveCount(0); // no Total row at all
  await expect(page.locator('body')).not.toContainText('$40.00');
  await expect(page.locator('.t-stat')).toHaveText('Price to confirm');
  await expect(page.locator('.pp-tbc')).toHaveText(HAND_PRICE);
  // A neutral question that already names the booking — nothing failed, so not "didn't go through".
  const wa = page.locator('#pricewa');
  await expect(wa).toBeVisible();
  const href = await wa.getAttribute('href');
  expect(href).toMatch(/^https:\/\/wa\.me\/94779669662\?text=/);
  expect(decodeURIComponent(href.split('text=')[1])).toBe('Hi Ceylon Hop, a question about booking CH-HAFDZ: ');
});

test('a Pay refused as awaiting a price says so, never "already paid or closed"', async ({ page }) => {
  // A view without the flag (e.g. served before it existed) still shows Pay; the refusal decides.
  await stub(page, { ...UNPRICED, needsPricing: undefined });
  await page.route('**/bookings/view/checkout-token', (r) => r.fulfill({
    status: 409, contentType: 'application/json',
    body: JSON.stringify({ error: 'not_chargeable', reason: 'awaiting_price', status: 'draft' }),
  }));
  await page.goto(PAGE);
  await page.locator('#paybtn').click();
  await expect(page.locator('.pp-tbc')).toHaveText(HAND_PRICE);
  await expect(page.locator('#paybtn')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText('already been paid');
});
