import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// Spec 2026-11-12 (booking pane PR 2): body order, folded sections, every team note.

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
  paid: [row('paid', 'CH-0001', { paymentStatus: 'paid', opsNotes: '[2026-11-10 09:12] Customer asked for a child seat\n[2026-11-11 15:40] Van confirmed, driver Sunil' }), detail('paid', 'CH-0001', 'paid', futureIsoDate(10))],
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
const fold = (page, k) => page.locator(`#sheet details.fold[data-fold="${k}"]`);

test('contact, payment, pickup, history and refund/cancel are folded on a paid booking', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  for (const k of ['contact', 'payment', 'pickup', 'history', 'refund']) {
    await expect(fold(page, k)).toHaveCount(1);
    await expect(fold(page, k)).not.toHaveAttribute('open', '');
  }
  await expect(fold(page, 'payment').locator('summary .fold-sum')).toHaveText('Paid');
  await expect(fold(page, 'contact').locator('summary .fold-sum')).toContainText('+94 77 000 0000');
});

test('payment opens by itself when money needs handling', async ({ page }) => {
  await boot(page);
  await open(page, 'quotelater');
  await expect(fold(page, 'payment')).toHaveAttribute('open', '');
});

test('a fold the operator opened survives a refresh', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await fold(page, 'history').locator('summary').click();
  await expect(fold(page, 'history')).toHaveAttribute('open', '');
  // A toggle on the pickup switch re-renders the sheet through morphSheet.
  await fold(page, 'pickup').locator('summary').click();
  await page.locator('#sheet [data-act="toggle"][data-k="photo"]').click();
  await expect(fold(page, 'history')).toHaveAttribute('open', '');
  await expect(fold(page, 'pickup')).toHaveAttribute('open', '');
});

test('every team note shows, oldest first, with its time', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  const notes = page.getByTestId('sheet-team-notes').locator('.tn');
  await expect(notes).toHaveCount(2);
  await expect(notes.nth(0)).toContainText('Customer asked for a child seat');
  await expect(notes.nth(0).locator('.tn-at')).toHaveText('2026-11-10 09:12');
  await expect(notes.nth(1)).toContainText('Van confirmed, driver Sunil');
  // Said once: History no longer repeats the notes.
  await fold(page, 'history').locator('summary').click();
  await expect(fold(page, 'history')).not.toContainText('child seat');
});

test('the duplicate When, Guests and Status rows are gone; the date control stays', async ({ page }) => {
  await boot(page);
  await open(page, 'paid');
  await expect(page.locator('#sheet .sheet-b .kv .k', { hasText: /^(When|Guests|Status)$/ })).toHaveCount(0);
  await expect(page.locator('#sheet [data-act="schedopen"]')).toBeVisible();
});

test('order in one column: note, then itinerary, then team notes', async ({ page }) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await boot(page);
  await open(page, 'paid');
  const ys = await page.evaluate(() => ['[data-testid="sheet-customer-note"]', '[data-testid="sheet-itinerary"]', '[data-testid="sheet-team-notes"]']
    .map((s) => document.querySelector('#sheet ' + s).getBoundingClientRect().top));
  expect(ys[0]).toBeLessThan(ys[1]);
  expect(ys[1]).toBeLessThan(ys[2]);
});
