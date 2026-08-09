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
  await expect(page.locator('.fact', { hasText: 'Pick-up time' })).toContainText('To be confirmed');
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
