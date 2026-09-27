import { test, expect } from '@playwright/test';

// Route choice (spec 2026-09-26 §4.3): a customer can buy the cheaper toll-free "local road".
// The ops shell must say so wherever an operator acts on the booking — the queue card (a small
// tag), the WhatsApp payment reminder, and the Lookup's Booking block — and say nothing new on
// the expressway. Offline: whoami, the queue, the drawer and the case are stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Road Customer',
  customerFirstName: 'Road', customerPhone: null, mode: 'single', route: 'Colombo Airport → Ella', road: 'Local road',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 8999, currency: 'USD',
  stage: 'awaiting_payment', paymentStatus: 'unpaid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking', isTest: false,
};
const PLAIN = { ...ROW, id: 'b2', reference: 'CH-0002', customerName: 'Plain Customer', customerFirstName: 'Plain', road: null };

const detail = (id) => ({
  payLink: `https://pay.example.test/PAY-${id}`,
  booking: { id, reference: id === 'b1' ? 'CH-0001' : 'CH-0002', currency: 'USD', status: 'payment_pending', mode: 'single',
    createdAt: '2026-09-25T08:00:00.000Z', input: { customer: { whatsapp: '+94 77 123 4567', email: 'r@e2e.test', country: 'US' } } },
  ops: { fulfilmentStatus: 'awaiting_payment' }, payments: [], refunds: [], coverage: null, checkoutEvents: [],
});

const CASE_BOOKING = {
  id: 'b1', reference: 'CH-0001', status: 'payment_pending', mode: 'single', channel: 'website',
  createdAt: '2026-09-25T08:00:00.000Z', route: 'Colombo Airport → Ella', road: 'Local road, no expressway · about 6h 14m',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, total: 8999, amountDueNow: 8999, currency: 'USD',
  customer: { firstName: 'Road', lastName: 'Customer', email: 'r@e2e.test', whatsapp: '+94 77 123 4567', country: 'US' },
  billing: null, termsAcceptedAt: null, cancellation: null, isTest: false, inQueue: true,
};
const caseFor = (booking) => ({
  ref: booking.reference, quote: null, booking,
  verdict: { kind: 'never_started', countsComplete: true, warnings: [] },
  timeline: [{ at: booking.createdAt, source: 'bookings', kind: 'created' }], gaps: [], unavailable: [],
});
const CASES = {
  'CH-0001': caseFor(CASE_BOOKING),
  'CH-0002': caseFor({ ...CASE_BOOKING, id: 'b2', reference: 'CH-0002', road: null }),
};

async function boot(page, caps = ['bookings:read', 'bookings:operate']) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
    });
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([ROW, PLAIN])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(detail('b1'))));
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(detail('b2'))));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/cases/**', (r) => {
    const ref = decodeURIComponent(new URL(r.request().url()).pathname.split('/').pop()).toUpperCase();
    return r.fulfill(CASES[ref] ? json(CASES[ref]) : { status: 404, contentType: 'application/json', body: '{"error":"not_found"}' });
  });
  await page.goto(OPS_FILE);
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

test('the queue card tags a local-road booking, and only that one', async ({ page }) => {
  await boot(page);
  await expect(page.locator('.tk[data-id="b1"] .tk-road')).toHaveText('local road');
  await expect(page.locator('.tk[data-id="b2"] .tk-road')).toHaveCount(0);
  // The route line itself is unchanged.
  await expect(page.locator('.tk[data-id="b1"] .tk-route b')).toHaveText('Colombo Airport → Ella');
});

async function copyReminder(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.locator('[data-act="payreminder"]').click();
  await expect.poll(() => page.evaluate(() => window.__copied.length)).toBeGreaterThan(0);
  const text = await page.evaluate(() => window.__copied.pop());
  await page.keyboard.press('Escape');
  return text;
}

test('the payment reminder says the booking is on the local road, and the expressway one is unchanged', async ({ page }) => {
  await boot(page);
  expect(await copyReminder(page, 'b1')).toContain('your booking for Colombo Airport → Ella (via the local road) is held pending payment');
  const plain = await copyReminder(page, 'b2');
  expect(plain).toContain('your booking for Colombo Airport → Ella is held pending payment');
  expect(plain).not.toContain('local road');
});

test('the Lookup shows a Road row for a local-road booking, and none otherwise', async ({ page }) => {
  const FINANCE = ['bookings:read', 'bookings:operate', 'payments:act'];
  await boot(page, FINANCE);
  const header = page.locator('[data-testid="lookup-header"]');
  await page.locator('[data-testid="lookup-nav"]').click();
  await page.fill('#lookup-q', 'CH-0001');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(header).toContainText('CH-0001');
  await expect(header.locator('.kv', { has: page.locator('.k', { hasText: /^Road$/ }) }).locator('.v')).toHaveText('Local road, no expressway · about 6h 14m');
  await page.fill('#lookup-q', 'CH-0002');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(header).toContainText('CH-0002');
  await expect(header.locator('.k', { hasText: /^Road$/ })).toHaveCount(0);
});
