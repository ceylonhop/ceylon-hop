import { test, expect } from '@playwright/test';

// Refund approvals phase 2 (owner rule 2026-10-17): ticking legs/extras FILLS the refund amount
// from the booking's frozen line prices (already pro-rated server-side) and names them in the
// reason. A convenience only — the amount stays editable and a founder approves every request.
// Clicks use dispatchEvent, as ops-refund-approval.spec.js does.
const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const row = {
  id: 'booking-1', reference: 'CH-LP001', channel: 'web', customerName: 'Picker Traveller',
  customerFirstName: 'Picker', mode: 'trip', route: 'Colombo → Kandy → Ella', travelDate: '2030-01-15',
  travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD', stage: 'paid', paymentStatus: 'paid',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', refundWaitingCents: 0,
};
const refundLines = {
  currency: 'USD',
  lines: [
    { kind: 'leg', index: 0, label: 'Colombo → Kandy (car)', amountCents: 4000 },
    { kind: 'leg', index: 1, label: 'Kandy → Ella (car)', amountCents: 5000 },
    { kind: 'extra', index: 0, label: 'Waiting fee — Kandy → Ella', amountCents: 1000, legIndex: 1 },
  ],
};
const detailWith = (extra) => ({
  booking: {
    id: 'booking-1', reference: 'CH-LP001', mode: 'single', status: 'paid', total: 10000, currency: 'USD',
    createdAt: '2030-01-01T10:00:00.000Z',
    input: { from: 'Colombo', to: 'Ella', customer: { firstName: 'Picker', lastName: 'Traveller', email: 'p@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' } },
  },
  ops: {},
  payments: [{ id: 'payment-1', bookingId: 'booking-1', provider: 'payhere', orderId: 'CH-LP001', amount: 10000, currency: 'USD', status: 'succeeded' }],
  ...extra,
});

async function boot(page, { detail, store }) {
  store.posts = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'ops@e2e.test', role: 'ops', caps: ['bookings:read', 'bookings:operate'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(detail)));
  await page.route('**/admin/bookings/booking-1/refunds', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill(json(store.refunds));
    const body = r.request().postDataJSON();
    store.posts.push(body);
    const refund = {
      id: `refund-${store.refunds.length + 1}`, bookingId: 'booking-1', paymentId: 'payment-1', provider: 'payhere',
      amountCents: body.amountCents, currency: 'USD', status: 'manual_pending', reason: body.reason, gatewayRef: null,
      requestedBy: 'ops@e2e.test', requestedAt: '2030-01-02T10:00:00.000Z',
      confirmedBy: null, confirmedAt: null, createdAt: '2030-01-02T10:00:00.000Z', updatedAt: '2030-01-02T10:00:00.000Z',
    };
    store.refunds.push(refund);
    return r.fulfill(json(refund, 201));
  });
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  await page.locator('[data-act="open"][data-id="booking-1"]').dispatchEvent('click');
  await page.waitForSelector('#sheet.show .sheet-b', { timeout: 10000 });
}
const tick = (page, label) => page.locator('.refund-lines label', { hasText: label }).locator('input').check();

test('ticking legs fills the amount and names them in the reason; the request posts that amount', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { detail: detailWith({ refundLines }), store });
  await page.locator('#refundreason').fill('Customer skipped Ella');
  await tick(page, 'Kandy → Ella (car)');
  await expect(page.locator('#refundamount')).toHaveValue('50.00');
  await tick(page, 'Waiting fee');
  await expect(page.locator('#refundamount')).toHaveValue('60.00');
  await expect(page.locator('#refundreason')).toHaveValue('Customer skipped Ella — Refunding: Kandy → Ella (car); Waiting fee — Kandy → Ella');
  // Unticking takes its line back out of both.
  await page.locator('.refund-lines label', { hasText: 'Waiting fee' }).locator('input').uncheck();
  await expect(page.locator('#refundamount')).toHaveValue('50.00');
  await expect(page.locator('#refundreason')).toHaveValue('Customer skipped Ella — Refunding: Kandy → Ella (car)');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-row')).toHaveCount(1);
  expect(store.posts).toEqual([{ amountCents: 5000, currency: 'USD', reason: 'Customer skipped Ella — Refunding: Kandy → Ella (car)' }]);
});

test('the filled amount stays editable', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { detail: detailWith({ refundLines }), store });
  await tick(page, 'Colombo → Kandy (car)');
  await page.locator('#refundamount').fill('35');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-row')).toHaveCount(1);
  expect(store.posts[0]).toEqual({ amountCents: 3500, currency: 'USD', reason: 'Refunding: Colombo → Kandy (car)' });
});

test('ticking everything means the full remaining amount', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { detail: detailWith({ refundLines }), store });
  for (const l of refundLines.lines) await tick(page, l.label);
  await expect(page.locator('#refundamount')).toHaveValue('');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-row')).toHaveCount(1);
  expect(store.posts[0].amountCents).toBe(10000);
});

test('a ticked sum above what is left fills only what is left, and says so', async ({ page }) => {
  const settled = {
    id: 'refund-0', bookingId: 'booking-1', paymentId: 'payment-1', provider: 'payhere', amountCents: 6000, currency: 'USD',
    status: 'api_confirmed', reason: 'Earlier', gatewayRef: 'R1', requestedBy: 'f@e2e.test', requestedAt: '2030-01-02T09:00:00.000Z',
    confirmedBy: 'f@e2e.test', confirmedAt: '2030-01-02T09:05:00.000Z', createdAt: '2030-01-02T09:00:00.000Z', updatedAt: '2030-01-02T09:05:00.000Z',
  };
  await boot(page, { detail: detailWith({ refundLines }), store: { refunds: [settled] } });
  await tick(page, 'Kandy → Ella (car)');
  await expect(page.locator('#refundamount')).toHaveValue('40.00');
  await expect(page.locator('.refund-lines')).toContainText('only $40 is left');
});

test('a booking without charge lines shows no picker', async ({ page }) => {
  await boot(page, { detail: detailWith({ refundLines: null }), store: { refunds: [] } });
  await expect(page.locator('#refundamount')).toBeVisible();
  await expect(page.locator('.refund-lines')).toHaveCount(0);
});
