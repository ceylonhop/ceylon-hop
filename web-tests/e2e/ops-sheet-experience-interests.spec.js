import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// The booking sheet's "Interested in" block (spec 2026-10-06 D15). Offline: the ops shell with a
// stubbed API. The status control exists only for bookings:operate (finance holds bookings:read
// and would get a 403 from the PATCH), and every value is escaped.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const row = (id, ref) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode: 'single', route: 'Colombo → Sigiriya', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 2,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null,
});
const INTEREST = {
  id: 'aaaaaaaa-0000-4000-8000-000000000001', experienceName: 'Ayurvedic massage', areaLabel: 'Sigiriya', nameSnapshot: 'Ayurvedic massage',
  priceCentsSnapshot: 3500, priceUnitSnapshot: 'per_person', status: 'new', paymentRef: null, amountPaidCents: null, amountPaidCurrency: null, opsNote: null,
};
const detail = (id, experienceInterests) => ({
  payLink: null, experienceInterests,
  booking: { id, reference: id === 'b1' ? 'CH-0001' : 'CH-0002', currency: 'USD', status: 'paid', mode: 'single', createdAt: '2026-09-01T00:00:00Z',
    input: { customer: { whatsapp: '+94 77 000 0000', email: `${id}@example.com`, country: 'Spain' } } },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
});

async function boot(page, caps, interests) {
  const calls = { patch: [] };
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row('b1', 'CH-0001'), row('b2', 'CH-0002')])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(detail('b1', interests))));
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(detail('b2', []))));
  await page.route('**/admin/experiences/leads/*', (r) => {
    calls.patch.push({ id: r.request().url().split('/').pop(), body: r.request().postDataJSON() });
    return r.fulfill(json({ lead: {} }));
  });
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  return calls;
}
async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}
const block = (page) => page.locator('.sheet-b .block', { has: page.locator('h4', { hasText: /^Interested in$/ }) });

test('the sheet lists what the customer is interested in, after the Trip block', async ({ page }) => {
  await boot(page, ['bookings:operate', 'bookings:read'], [INTEREST]);
  await open(page, 'b1');
  await expect(block(page)).toHaveCount(1);
  await expect(block(page)).toContainText('Ayurvedic massage');
  await expect(block(page)).toContainText('Sigiriya');
  await expect(block(page)).toContainText('$35 pp');
  const heads = await page.locator('.sheet-b .block h4').allTextContents();
  expect(heads.indexOf('Interested in')).toBe(heads.indexOf('Trip') + 1);
});

test('no interests, no block', async ({ page }) => {
  await boot(page, ['bookings:operate', 'bookings:read'], [INTEREST]);
  await open(page, 'b2');
  await expect(page.locator('.sheet-b')).toContainText('b2@example.com');
  await expect(block(page)).toHaveCount(0);
});

test('an operator can set the status; the PATCH carries only {status}', async ({ page }) => {
  const calls = await boot(page, ['bookings:operate', 'bookings:read'], [INTEREST]);
  await open(page, 'b1');
  await block(page).locator('select[data-act="intstatus"]').selectOption('contacted');
  await expect.poll(() => calls.patch.length).toBe(1);
  expect(calls.patch[0]).toEqual({ id: INTEREST.id, body: { status: 'contacted' } });
});

test('paid with no stored reference sends nothing and points to the Experiences page', async ({ page }) => {
  const calls = await boot(page, ['bookings:operate', 'bookings:read'], [INTEREST]);
  await open(page, 'b1');
  await block(page).locator('select[data-act="intstatus"]').selectOption('paid');
  await expect(page.locator('#toast')).toContainText('Add the PayHere reference first');
  await expect(block(page).locator('select[data-act="intstatus"]')).toHaveValue('new');
  expect(calls.patch).toEqual([]);
});

test('finance sees read-only status text, no control', async ({ page }) => {
  await boot(page, ['bookings:read', 'payments:act'], [{ ...INTEREST, status: 'link_sent', paymentRef: 'PH-1' }]);
  await open(page, 'b1');
  await expect(block(page)).toContainText('Link sent');
  await expect(block(page).locator('select')).toHaveCount(0);
});

test('values are escaped', async ({ page }) => {
  await boot(page, ['bookings:operate', 'bookings:read'], [{ ...INTEREST, experienceName: '<img src=x onerror=window.__pwned=1>', opsNote: 'say "hi" <b>x</b>' }]);
  await open(page, 'b1');
  await expect(block(page)).toContainText('<img src=x onerror=window.__pwned=1>');
  await expect(block(page).locator('img')).toHaveCount(0);
  expect(await page.evaluate(() => window.__pwned)).toBeUndefined();
});

// D21: the schedule and the confirmation are read-only here; they are entered on the Leads tab.
test('the sheet shows when and where, and that the confirmation went, read-only', async ({ page }) => {
  const day = futureIsoDate(40);
  await boot(page, ['bookings:operate', 'bookings:read'], [{
    ...INTEREST, status: 'paid', paymentRef: 'PH-1', scheduledDate: day, scheduledTime: '09:30',
    meetingPoint: 'Hotel <b>lobby</b>', confirmationSentAt: '2026-10-07T04:15:00.000Z',
  }]);
  await open(page, 'b1');
  await expect(block(page).locator('[data-testid="sheet-interest-scheduled"]')).toHaveText(`${day} 09:30 · Hotel <b>lobby</b>`);
  await expect(block(page).locator('[data-testid="sheet-interest-confirmed"]')).toHaveText('Confirmation sent ✓');
  await expect(block(page).locator('input')).toHaveCount(0);
});

test('an unscheduled, unconfirmed interest shows neither line', async ({ page }) => {
  await boot(page, ['bookings:operate', 'bookings:read'], [INTEREST]);
  await open(page, 'b1');
  await expect(block(page).locator('[data-testid="sheet-interest-scheduled"]')).toHaveCount(0);
  await expect(block(page).locator('[data-testid="sheet-interest-confirmed"]')).toHaveCount(0);
});
