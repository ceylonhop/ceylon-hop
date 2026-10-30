import { test, expect } from '@playwright/test';

// Pay on the day (owner 2026-10-29/30): a founder books a WhatsApp customer whose card failed as
// "Customer pays cash on the day". The booking is confirmed with nothing paid; the customer pays
// USD cash to the Ceylon Hop team at the first pickup, and a founder/finance records it later.
// The console must not say "Paid" before then. Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const row = (over = {}) => ({
  id: 'booking-1', reference: 'CH-CASH1', channel: 'whatsapp', customerName: 'Cash Traveller', customerFirstName: 'Cash',
  mode: 'single', route: 'Colombo → Ella', travelDate: '2030-01-15', travelTime: '09:00', pax: 2,
  amount: 34200, currency: 'USD', stage: 'paid', paymentStatus: 'unpaid', paidCents: 0, balanceCents: 34200,
  paymentArrangement: 'on_the_day', cashDueCents: 34200,
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', ...over,
});
const detail = () => ({
  booking: { id: 'booking-1', reference: 'CH-CASH1', mode: 'single', status: 'confirmed', total: 34200, currency: 'USD', createdAt: '2030-01-01T10:00:00.000Z',
    paymentArrangement: 'on_the_day',
    input: { from: 'Colombo', to: 'Ella', customer: { firstName: 'Cash', lastName: 'Traveller', email: 'c@example.com', whatsapp: '+94770000000', country: 'UK' } } },
  ops: {}, payments: [], payLink: null,
});
const FOUNDER = ['bookings:read', 'bookings:operate', 'payments:act', 'payments:reverse'];
const OPS_ROLE = ['bookings:read', 'bookings:operate'];

async function boot(page, { theRow = row(), caps = FOUNDER, open = true } = {}) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: caps === FOUNDER ? 'founder' : 'ops', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([theRow])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(detail())));
  await page.goto(OPS_FILE);
  if (open) {
    await page.locator('[data-act="open"][data-id="booking-1"]').click();
    await expect(page.locator('#sheet')).toHaveClass(/show/);
  }
}
const payBlock = (page) => page.locator('#sheet .block', { has: page.locator('h4', { hasText: 'Payment' }) });

test('the queue row reads "Confirmed · cash due", not "Paid", and stays out of Awaiting payment', async ({ page }) => {
  await boot(page, { open: false });
  const pill = page.locator('.tk .tk-side .pill').first();
  await expect(pill).toHaveText('Confirmed · cash due');
  await expect(pill).toHaveClass(/pill-bal/); // the existing amber
  await expect(page.locator('.tk')).not.toContainText('Paid');
});

test('a later stage keeps its label and carries a "Cash due $342" chip', async ({ page }) => {
  await boot(page, { theRow: row({ stage: 'vehicle_confirmed' }), open: false });
  const pills = page.locator('.tk .tk-side .pill');
  await expect(pills.first()).toHaveText('Vehicle confirmed');
  await expect(pills.nth(1)).toHaveText('Cash due $342');
});

test('the drawer: amber header pill, "Cash due" pipeline step, the pay-on-the-day note and status', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#sheet .sheet-h .idrow .pill').first()).toHaveText('Confirmed · cash due');
  await expect(page.locator('#sheet .pstep').nth(1)).toHaveText('Cash due');
  await expect(page.locator('#sheet .pstep.done')).toHaveCount(1); // only "Awaiting" is behind it
  const pay = payBlock(page);
  await expect(pay).toContainText("Pay on the day — $342 in US dollars cash to the Ceylon Hop team, at the first pickup. Record it here when it's collected.");
  await expect(pay.getByText('Status', { exact: true }).locator('..').locator('.v')).toHaveText('Cash due on the day');
  await expect(pay).not.toContainText('payment link');
  await expect(page.locator('[data-act="payreminder"]')).toHaveCount(0);
  await expect(page.locator('[data-act="paylink"]')).toHaveCount(0);
});

test('a founder records the cash: confirm copy, then POST mark-paid', async ({ page }) => {
  await boot(page);
  const btn = page.locator('#sheet [data-act="markpaid"]');
  await expect(btn).toHaveText('Record cash collected');
  let said = '';
  page.on('dialog', (d) => { said = d.message(); d.accept(); });
  let posted = null;
  await page.route('**/admin/bookings/booking-1/mark-paid', (r) => { posted = r.request().postDataJSON(); r.fulfill(json({ status: 'confirmed' })); });
  await page.locator('#paidmethod').selectOption('cash');
  await btn.click();
  await expect.poll(() => posted).toEqual({ method: 'cash' });
  expect(said).toBe('Record $342 received in cash for CH-CASH1? The trip status stays as it is. No email goes to the customer.');
});

test('an ops-role session sees the note but not the Record cash button', async ({ page }) => {
  await boot(page, { caps: OPS_ROLE });
  await expect(payBlock(page)).toContainText('Pay on the day — $342 in US dollars cash to the Ceylon Hop team, at the first pickup.');
  await expect(page.locator('[data-act="markpaid"]')).toHaveCount(0);
  await expect(page.locator('#paidmethod')).toHaveCount(0);
});

test('no-show on a booking with nothing paid does not claim a non-refundable fare', async ({ page }) => {
  await boot(page);
  let said = '';
  page.on('dialog', (d) => { said = d.message(); d.dismiss(); });
  await page.locator('#sheet [data-act="noshow"]').click();
  await expect.poll(() => said).toContain('nothing was charged');
  expect(said).not.toContain('refundable');
});
