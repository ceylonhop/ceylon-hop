import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// The booking sheet's fixed header has a WhatsApp icon that opens that customer's chat (owner,
// 2026-11-05). The number is stored as typed, with spaces, so the link must carry digits only.
// With no usable number there is nothing to open, so there is no icon.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const row = (id, ref) => ({
  id, reference: ref, channel: 'website', customerName: 'Alpha Customer', customerFirstName: 'Alpha',
  mode: 'single', route: 'Colombo → Galle', travelDate: futureIsoDate(30), travelTime: '09:00', pax: 2,
  amount: 3900, currency: 'USD', stage: 'paid', paymentStatus: 'succeeded',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', source: 'booking', board: null,
});

const detail = (id, whatsapp) => ({
  payLink: null,
  booking: { id, reference: id.toUpperCase(), currency: 'USD', status: 'paid', mode: 'single',
    createdAt: '2026-09-01T00:00:00Z',
    input: { customer: { whatsapp, email: `${id}@example.com`, country: 'Spain' } } },
  ops: { updatedAt: '2026-09-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: 3900, currency: 'USD' }],
  refunds: [],
});

const NUMBERS = { b1: '+94 77 123-4567', b2: undefined, b3: '+94 7' };

async function boot(page) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all first: Playwright gives precedence to the LAST matching route.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(Object.keys(NUMBERS).map((id) => row(id, id.toUpperCase())))));
  for (const [id, number] of Object.entries(NUMBERS)) {
    await page.route(`**/admin/ops/bookings/${id}`, (r) => r.fulfill(json(detail(id, number))));
  }
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}

test("the sheet header's WhatsApp icon opens that customer's chat in a new tab", async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  const icon = page.locator('.sheet-h').getByRole('link', { name: 'Message on WhatsApp' });
  await expect(icon).toHaveAttribute('href', 'https://wa.me/94771234567');
  await expect(icon).toHaveAttribute('target', '_blank');
  // The number in the Customer block opens the same chat, and still reads as typed.
  const number = page.locator('.sheet-b a[href*="wa.me"]');
  await expect(number).toHaveText('+94 77 123-4567');
  await expect(number).toHaveAttribute('href', 'https://wa.me/94771234567');
  await expect(number).toHaveAttribute('target', '_blank');
});

test('the icon stays on screen when the sheet body is scrolled', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 420 });
  await boot(page);
  await open(page, 'b1');
  await page.locator('.sheet-b').evaluate((el) => { el.scrollTop = el.scrollHeight; });
  await expect(page.locator('.sheet-h').getByRole('link', { name: 'Message on WhatsApp' })).toBeInViewport();
});

test('no number on file means no icon and no link', async ({ page }) => {
  await boot(page);
  await open(page, 'b2');
  await expect(page.locator('.sheet-b')).toContainText('No number on file');
  await expect(page.locator('#sheet a[href*="wa.me"]')).toHaveCount(0);
});

test('a number too short to dial shows as text, with no icon and no link', async ({ page }) => {
  await boot(page);
  await open(page, 'b3');
  await expect(page.locator('.sheet-b')).toContainText('+94 7');
  await expect(page.locator('#sheet a[href*="wa.me"]')).toHaveCount(0);
});
