import { test, expect } from '@playwright/test';

// Ops sees the open balance of a deposit booking and can copy the pay link to resend it (spec
// 2026-10-07 §5.4, rev. 2026-10-08). Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PAY_LINK = 'https://pay.example/p?t=SIGNED-TOKEN';

const row = (over = {}) => ({
  id: 'booking-1', reference: 'CH-BAL01', channel: 'website', customerName: 'Deposit Traveller', customerFirstName: 'Deposit',
  mode: 'single', route: 'Colombo → Galle', travelDate: '2030-01-15', travelTime: '09:00', pax: 2,
  amount: 21900, currency: 'USD', stage: 'paid', paymentStatus: 'paid', paidCents: 5000, balanceCents: 16900,
  vehiclePhotoReceived: true, customerUpdated: true, opsNotes: '', ...over,
});
const detail = (over = {}) => ({
  booking: { id: 'booking-1', reference: 'CH-BAL01', mode: 'single', status: 'paid', total: 21900, currency: 'USD', createdAt: '2030-01-01T10:00:00.000Z',
    input: { from: 'Colombo', to: 'Galle', customer: { firstName: 'Deposit', lastName: 'Traveller', email: 'd@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' } } },
  ops: {},
  payments: [{ id: 'p-1', bookingId: 'booking-1', provider: 'payhere', orderId: 'CH-BAL01-D', amount: 5000, currency: 'USD', status: 'succeeded', purpose: 'deposit' }],
  balancePayLink: PAY_LINK,
  ...over,
});

async function boot(page, { theRow = row(), theDetail = detail(), open = true } = {}) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['bookings:read', 'bookings:operate'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([theRow])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(theDetail)));
  await page.goto(OPS_FILE);
  if (open) {
    await page.locator('[data-act="open"][data-id="booking-1"]').click();
    await expect(page.locator('#sheet')).toHaveClass(/show/);
  }
}

test('the list row carries a "Balance $169" pill', async ({ page }) => {
  await boot(page, { open: false });
  await expect(page.locator('.tk .pill-bal')).toHaveText('Balance $169');
});

test('a fully paid row has no balance pill', async ({ page }) => {
  await boot(page, { theRow: row({ paidCents: 21900, balanceCents: 0 }), open: false });
  await expect(page.locator('.tk')).toHaveCount(1);
  await expect(page.locator('.tk .pill-bal')).toHaveCount(0);
});

test('a balance still open on the day of travel is an attention reason on the row', async ({ page }) => {
  await boot(page, { theRow: row({ travelDate: isoOf(new Date()) }), open: false });
  await expect(page.locator('.tk .reason')).toHaveText('Balance due — travels today');
});

test('the drawer shows Paid so far, Balance due and the Deposit paid status', async ({ page }) => {
  await boot(page);
  const pay = page.locator('.block', { has: page.locator('h4', { hasText: 'Payment' }) });
  await expect(pay.getByText('Paid so far').locator('..').locator('.v')).toHaveText('$50');
  await expect(pay.getByText('Balance due').locator('..').locator('.v')).toHaveText('$169');
  await expect(pay.getByText('Status').locator('..').locator('.v')).toHaveText('Deposit paid');
});

test('Copy pay link copies the booking’s balancePayLink', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.locator('[data-act="balancelink"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PAY_LINK);
});

test('no balance, no button: a fully paid booking offers no pay link', async ({ page }) => {
  await boot(page, { theRow: row({ paidCents: 21900, balanceCents: 0 }), theDetail: detail({ balancePayLink: null }) });
  await expect(page.locator('[data-act="balancelink"]')).toHaveCount(0);
  const pay = page.locator('.block', { has: page.locator('h4', { hasText: 'Payment' }) });
  await expect(pay.getByText('Status').locator('..').locator('.v')).toHaveText('Paid');
  await expect(pay.getByText('Balance due')).toHaveCount(0);
});
