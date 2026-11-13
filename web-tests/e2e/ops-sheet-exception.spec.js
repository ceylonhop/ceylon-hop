import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Spec 2026-11-12 decision 11 (booking pane PR 2): money only rises when there is something to do,
// as ONE line under the name. Amber = expected and needs handling; red = blocks the trip. An unpaid
// website checkout is never red (owner: don't chase abandoned checkouts, 2026-10-29).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const CUSTOMER = { whatsapp: '+94 77 000 0000', email: 'c@example.com', country: 'Spain' };

const row = (id, ref, extra = {}) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode: 'single', route: 'A → B', travelDate: futureIsoDate(10), travelTime: '09:00', pax: 2,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null, ...extra,
});
const detail = (id, ref, status, date) => ({
  payLink: null, vehicle: 'car',
  booking: { id, reference: ref, currency: 'USD', status, mode: 'single', createdAt: '2026-09-01T00:00:00Z',
    input: { customer: CUSTOMER, from: 'A, x', to: 'B, y', date, time: '09:00', vehicleType: 'car', adults: 2, children: 0, bags: 1 } },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [], refunds: [],
});

const CASES = {
  paid: [row('paid', 'CH-0001'), detail('paid', 'CH-0001', 'paid', futureIsoDate(10))],
  webunpaid: [row('webunpaid', 'CH-0002', { stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(1) }), detail('webunpaid', 'CH-0002', 'payment_pending', futureIsoDate(1))],
  quotesoon: [row('quotesoon', 'CH-0003', { channel: 'whatsapp', stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(1) }), detail('quotesoon', 'CH-0003', 'payment_pending', futureIsoDate(1))],
  quotelater: [row('quotelater', 'CH-0004', { channel: 'whatsapp', stage: 'awaiting_payment', paymentStatus: 'pending', travelDate: futureIsoDate(10) }), detail('quotelater', 'CH-0004', 'payment_pending', futureIsoDate(10))],
  cancelled: [row('cancelled', 'CH-0005', { stage: 'cancelled' }), detail('cancelled', 'CH-0005', 'cancelled', futureIsoDate(10))],
};

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(Object.values(CASES).map(([rw]) => rw))));
  for (const [id, [, d]] of Object.entries(CASES)) await page.route(`**/admin/ops/bookings/${id}`, (r) => r.fulfill(json(d)));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}
async function open(page, id) {
  // "All open" hides closed rows; the Closed chip (group 'done') is where a cancelled booking lives.
  const tk = page.locator(`.tk[data-act="open"][data-id="${id}"]`);
  if (!(await tk.count())) await page.locator('.fchip[data-g="done"]').click();
  await tk.click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}
const exc = (page) => page.locator('#sheet .sheet-h [data-testid="sheet-exception"]');

test('a booking paid in full shows no money line and no stepper', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await expect(exc(page)).toHaveCount(0);
  await expect(page.locator('#sheet .sheet-h .pipe')).toHaveCount(0);
  await expect(page.locator('#sheet .sheet-h .idrow .pill').first()).toBeVisible();
});

test('an unpaid website checkout is amber and factual, even travelling tomorrow', async ({ page }) => {
  await boot(page);
  await open(page, 'webunpaid');
  await expect(exc(page)).toHaveText('Checkout not completed · $39');
  await expect(exc(page)).toHaveClass(/tone-amber/);
});

test('an unpaid WhatsApp quote travelling within 48 hours is red', async ({ page }) => {
  await boot(page);
  await open(page, 'quotesoon');
  await expect(exc(page)).toHaveText('Not paid · travels within 48 hours · $39');
  await expect(exc(page)).toHaveClass(/tone-red/);
});

test('an unpaid WhatsApp quote further out is amber', async ({ page }) => {
  await boot(page);
  await open(page, 'quotelater');
  await expect(exc(page)).toHaveText('Not paid · $39');
  await expect(exc(page)).toHaveClass(/tone-amber/);
});

test('a cancelled booking names its outcome in grey', async ({ page }) => {
  await boot(page);
  await open(page, 'cancelled');
  await expect(exc(page)).toHaveText('Cancelled');
  await expect(exc(page)).toHaveClass(/tone-grey/);
});
