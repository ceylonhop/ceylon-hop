import { test, expect } from '@playwright/test';

// Spec 2026-10-17: ops requests any refund, a founder approves. These pin the ops side of the
// Refunds block and the founder's "Refunds waiting" chip. Clicks use dispatchEvent('click'), as
// ops-refund-workflow.spec.js does, so a sticky footer can never intercept them.
const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const baseRow = {
  id: 'booking-1', reference: 'CH-RA001', channel: 'web', customerName: 'Approval Traveller',
  customerFirstName: 'Approval', mode: 'single', route: 'Colombo → Kandy', travelDate: '2030-01-15',
  travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD', stage: 'paid', paymentStatus: 'paid',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', refundWaitingCents: 0,
};
const detail = {
  booking: {
    id: 'booking-1', reference: 'CH-RA001', mode: 'single', status: 'paid', total: 10000, currency: 'USD',
    createdAt: '2030-01-01T10:00:00.000Z',
    input: { from: 'Colombo', to: 'Kandy', customer: { firstName: 'Approval', lastName: 'Traveller', email: 'a@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' } },
  },
  ops: {},
  payments: [{ id: 'payment-1', bookingId: 'booking-1', provider: 'payhere', orderId: 'CH-RA001', amount: 10000, currency: 'USD', status: 'succeeded' }],
};
const CAPS = {
  ops: ['bookings:read', 'bookings:operate'],
  founder: ['bookings:read', 'bookings:operate', 'payments:act', 'payments:reverse'],
};

async function boot(page, { role, row = baseRow, store }) {
  store.posts = [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Last registered wins in Playwright: catch-all first, specifics after.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: `${role}@e2e.test`, role, caps: CAPS[role] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([row])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(detail)));
  await page.route('**/admin/bookings/booking-1/refunds', async (r) => {
    if (r.request().method() === 'GET') return r.fulfill(json(store.refunds));
    const body = r.request().postDataJSON();
    store.posts.push(body);
    const refund = {
      id: `refund-${store.refunds.length + 1}`, bookingId: 'booking-1', paymentId: 'payment-1', provider: 'payhere',
      amountCents: body.amountCents, currency: 'USD', status: 'manual_pending', reason: body.reason, gatewayRef: null,
      requestedBy: `${role}@e2e.test`, requestedAt: store.requestedAt || '2030-01-02T10:00:00.000Z',
      confirmedBy: null, confirmedAt: null, createdAt: '2030-01-02T10:00:00.000Z', updatedAt: '2030-01-02T10:00:00.000Z',
    };
    store.refunds.push(refund);
    return r.fulfill(json(refund, 201));
  });
  await page.route(/\/admin\/bookings\/booking-1\/refunds\/([^/]+)\/cancel$/, async (r) => {
    const id = new URL(r.request().url()).pathname.match(/refunds\/([^/]+)\/cancel$/)[1];
    const refund = store.refunds.find((x) => x.id === id);
    refund.status = 'cancelled';
    store.cancelled = (store.cancelled || 0) + 1;
    return r.fulfill(json(refund));
  });
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}
const openSheet = async (page) => {
  await page.locator('[data-act="open"][data-id="booking-1"]').dispatchEvent('click');
  await page.waitForSelector('#sheet.show .sheet-b', { timeout: 10000 });
};

test('ops requests a partial refund; nothing that moves money is offered', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await page.locator('#refundamount').fill('25.50');
  await page.locator('#refundreason').fill('Customer dropped the Kandy leg');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-row')).toHaveCount(1);
  expect(store.posts).toEqual([{ amountCents: 2550, currency: 'USD', reason: 'Customer dropped the Kandy leg' }]);
  await expect(page.getByText('Refund requested — waiting for a founder')).toBeVisible();
  await expect(page.locator('[data-act="refundexecute"]')).toHaveCount(0);
  await expect(page.locator('[data-act="refundconfirm"]')).toHaveCount(0);
});

test('an amount above what is left is refused before anything is posted', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (d) => d.accept());
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await page.locator('#refundamount').fill('150');
  await page.locator('#refundreason').fill('Too much');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.getByText('more than the $100 left to refund')).toBeVisible();
  expect(store.posts).toEqual([]);
});

test('the ops sheet survives a refund history that is not a list', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const store = { refunds: {} }; // what a catch-all mock (or an odd server answer) hands back
  await boot(page, { role: 'ops', store });
  await openSheet(page);
  await expect(page.getByText('Refundable remaining')).toBeVisible();
  expect(errors).toEqual([]);
});
