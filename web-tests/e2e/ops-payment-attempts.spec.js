import { test, expect } from '@playwright/test';

// Payment attempts (2026-09-24): debugging a failed payment took SQL against
// booking_checkout_event. GET /admin/ops/bookings/:id now carries `checkoutEvents` (oldest
// first) and the booking drawer shows them as a "Payment attempts" block — one plain-English
// row per step, plus a hint when PayHere never answered after the customer was sent there.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Pay Customer',
  customerFirstName: 'Pay', customerPhone: null, mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD',
  stage: 'awaiting_payment', paymentStatus: 'unpaid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking', isTest: false,
};

const detail = (checkoutEvents) => ({
  booking: {
    id: 'b1', reference: 'CH-0001', mode: 'single', status: 'payment_pending', createdAt: new Date().toISOString(),
    input: { customer: { email: 'pay@e2e.test', whatsapp: '+1', country: 'US' } },
  },
  ops: { fulfilmentStatus: 'awaiting_payment' },
  payments: [], payLink: null, coverage: null,
  ...(checkoutEvents === undefined ? {} : { checkoutEvents }),
});

const ev = (at, action, outcome, extra = {}) => ({
  at: at.toISOString(), action, outcome, reason: null, source: 'server', attempt: null, httpStatus: null, ...extra,
});

async function openDrawer(page, body) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps: ['bookings:read'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([ROW])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(body)));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  await page.locator('.tk[data-act="open"][data-id="b1"]').click();
  // The detail has landed once the skeleton gives way to the Customer block.
  await expect(page.locator('#sheet .block h4', { hasText: 'Customer' })).toBeVisible();
}

test('the drawer lists the payment attempts in plain English, with the no-answer hint', async ({ page }) => {
  const now = Date.now();
  const s = (secsAgo) => new Date(now - secsAgo * 1000);
  const older = new Date(now - 3 * 86400000); // three days ago → the row carries its date
  await openDrawer(page, detail([
    ev(older, 'create', 'succeeded'),
    ev(s(90), 'checkout', 'succeeded', { attempt: 1 }),
    ev(s(80), 'gateway', 'opened', { source: 'client' }),
    ev(s(70), 'gateway', 'error', { source: 'client', reason: 'Card <b>declined</b>' }),
    ev(s(60), 'webhook', 'failed'),
    ev(s(55), 'webhook', 'refused', { reason: 'bad_signature' }),
    ev(s(50), 'return', 'pending'),
    ev(s(40), 'checkout', 'succeeded', { attempt: 2 }),
    ev(s(30), 'gateway', 'opened', { source: 'client' }),
  ]));

  const block = page.locator('#sheet .block.pay-attempts');
  await expect(block.locator('h4')).toHaveText('Payment attempts');
  await expect(block.locator('.pa-row .pa-what')).toHaveText([
    'Booking created',
    'Checkout started (attempt 1)',
    'Sent to PayHere',
    'PayHere error: Card <b>declined</b>', // escaped: shown as text, never parsed as markup
    'PayHere: declined',
    'PayHere notify rejected: bad_signature',
    'Customer returned — no answer yet',
    'Checkout started (attempt 2)',
    'Sent to PayHere',
  ]);
  await expect(block.locator('b')).toHaveCount(0);
  // Today's rows carry just hh:mm; the three-day-old one carries its date too.
  await expect(block.locator('.pa-row').nth(8).locator('.pa-when')).toHaveText(/^\d{2}:\d{2}$/);
  await expect(block.locator('.pa-row').nth(0).locator('.pa-when')).toHaveText(/^\d{2} \w+ \d{2}:\d{2}$/);
  // Each row has a coloured outcome dot.
  await expect(block.locator('.pa-row .pa-dot')).toHaveCount(9);
  await expect(block.locator('.pa-hint')).toHaveText(
    'No answer from PayHere — if this was a 3-D Secure decline it only shows in the PayHere dashboard (search the reference)',
  );
});

test('the remaining labels, and no hint once PayHere has answered', async ({ page }) => {
  const now = Date.now();
  const s = (secsAgo) => new Date(now - secsAgo * 1000);
  await openDrawer(page, detail([
    ev(s(60), 'gateway', 'dismissed', { source: 'client' }),
    ev(s(50), 'webhook', 'dismissed'),
    ev(s(45), 'return', 'failed'),
    ev(s(42), 'checkout', 'succeeded', { attempt: 2 }),
    ev(s(40), 'webhook', 'settled'),
    ev(s(30), 'return', 'settled'),
  ]));
  const block = page.locator('#sheet .block.pay-attempts');
  await expect(block.locator('.pa-row .pa-what')).toHaveText([
    'Closed PayHere',
    'PayHere: cancelled',
    'Customer returned — declined',
    'Checkout started (attempt 2)',
    'PayHere: paid',
    'Customer returned — paid',
  ]);
  await expect(block.locator('.pa-hint')).toHaveCount(0);
});

test('no events → no Payment attempts block', async ({ page }) => {
  await openDrawer(page, detail([]));
  await expect(page.locator('#sheet .block.pay-attempts')).toHaveCount(0);
  await expect(page.locator('#sheet h4', { hasText: 'Payment attempts' })).toHaveCount(0);
});

test('an older API without checkoutEvents → no block', async ({ page }) => {
  await openDrawer(page, detail(undefined));
  await expect(page.locator('#sheet .block.pay-attempts')).toHaveCount(0);
});
