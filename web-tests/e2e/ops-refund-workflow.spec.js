import { test, expect } from '@playwright/test';

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

const row = {
  id: 'booking-1',
  reference: 'CH-RF001',
  channel: 'web',
  customerName: 'Refund Traveller',
  customerFirstName: 'Refund',
  mode: 'single',
  route: 'Colombo → Kandy',
  travelDate: '2030-01-15',
  travelTime: '09:00',
  pax: 2,
  amount: 10000,
  currency: 'USD',
  stage: 'paid',
  paymentStatus: 'paid',
  vehiclePhotoReceived: false,
  customerUpdated: false,
  opsNotes: '',
};

const bookingDetail = {
  booking: {
    id: row.id,
    reference: row.reference,
    mode: 'single',
    status: 'paid',
    total: 10000,
    currency: 'USD',
    createdAt: '2030-01-01T10:00:00.000Z',
    input: {
      from: 'Colombo',
      to: 'Kandy',
      customer: {
        firstName: 'Refund',
        lastName: 'Traveller',
        email: 'refund@example.com',
        whatsapp: '+94770000000',
        country: 'Sri Lanka',
      },
    },
  },
  ops: {},
  payments: [{
    id: 'payment-1',
    bookingId: row.id,
    provider: 'payhere',
    orderId: row.reference,
    amount: 10000,
    currency: 'USD',
    status: 'succeeded',
  }],
};

function makeRefund(store, amountCents, reason) {
  const id = `refund-${store.refunds.length + 1}`;
  return {
    id,
    bookingId: row.id,
    paymentId: 'payment-1',
    provider: 'payhere',
    amountCents,
    currency: 'USD',
    status: 'manual_pending',
    reason,
    gatewayRef: null,
    requestedBy: store.email,
    requestedAt: '2030-01-02T10:00:00.000Z',
    confirmedBy: null,
    confirmedAt: null,
    createdAt: '2030-01-02T10:00:00.000Z',
    updatedAt: '2030-01-02T10:00:00.000Z',
  };
}

async function boot(page, { role = 'finance', store, mobile = false } = {}) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  const paymentsAct = role === 'founder' || role === 'finance';
  const caps = ['bookings:read', 'bookings:operate', ...(paymentsAct ? ['payments:act'] : [])];
  store.email = `${role}@e2e.test`;
  store.requestPosts = store.requestPosts || 0;
  store.refundReads = store.refundReads || 0;

  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { importLibrary: async () => ({}) },
    };
  });
  await page.route('**/admin/**', (route) => route.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (route) =>
    route.fulfill(json({ email: store.email, role, caps })));
  await page.route('**/admin/ops/bookings', (route) => route.fulfill(json([row])));
  await page.route('**/admin/ops/bookings/booking-1', (route) =>
    route.fulfill(json(bookingDetail)));
  await page.route('**/admin/bookings/booking-1/refunds', async (route) => {
    if (route.request().method() === 'GET') {
      store.refundReads++;
      return route.fulfill(json(store.refunds));
    }
    store.requestPosts++;
    const body = route.request().postDataJSON();
    const refund = makeRefund(store, body.amountCents, body.reason);
    store.refunds.push(refund);
    return route.fulfill(json(refund, 201));
  });
  await page.route(/\/admin\/bookings\/booking-1\/refunds\/([^/]+)\/(confirm|cancel)$/, async (route) => {
    const match = new URL(route.request().url()).pathname.match(/refunds\/([^/]+)\/(confirm|cancel)$/);
    const refund = store.refunds.find((item) => item.id === match[1]);
    if (match[2] === 'confirm') {
      const body = route.request().postDataJSON();
      Object.assign(refund, {
        status: 'manual_confirmed',
        gatewayRef: body.gatewayRef,
        confirmedBy: store.email,
        confirmedAt: '2030-01-02T10:05:00.000Z',
      });
      return route.fulfill(json({ refund, bookingFullyRefunded: false }));
    }
    refund.status = 'cancelled';
    return route.fulfill(json(refund));
  });

  await page.goto(OPS_FILE);
  await page.locator('[data-act="open"][data-id="booking-1"]').click();
  await expect(page.locator('#sheet')).toHaveClass(/show/);
}

test('finance requests, reloads, and confirms a refund exactly once with PayHere evidence', async ({ page }) => {
  const store = { refunds: [] };
  await boot(page, { role: 'finance', store });

  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$100');
  await page.locator('#refundamount').fill('25.00');
  await page.locator('#refundreason').fill('Customer changed plans');
  const request = page.locator('[data-act="refundrequest"]');
  await request.dispatchEvent('click');
  await request.dispatchEvent('click');

  await expect(page.locator('.refund-status-manual_pending')).toContainText('$25');
  expect(store.requestPosts).toBe(1);
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$75');

  await page.reload();
  await page.locator('[data-act="open"][data-id="booking-1"]').click();
  await expect(page.locator('.refund-status-manual_pending')).toContainText('Customer changed plans');
  await expect(page.getByText('Complete the refund in the PayHere dashboard first')).toBeVisible();

  await page.locator('[data-refund-ref="refund-1"]').fill('PAYHERE-R-1001');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-act="refundconfirm"]').click();
  await expect(page.locator('.refund-status-manual_confirmed')).toContainText('PAYHERE-R-1001');
  await expect(page.locator('.refund-status-manual_confirmed')).toContainText('finance@e2e.test');
  await expect(page.locator('.block', { hasText: 'Activity' })).toContainText('Refund confirmed · $25');
});

test('founder can cancel a pending request and the balance becomes available again on mobile', async ({ page }) => {
  const store = { refunds: [makeRefund({ refunds: [], email: 'finance@e2e.test' }, 3000, 'Duplicate charge')] };
  await boot(page, { role: 'founder', store, mobile: true });

  await expect(page.locator('.refund-status-manual_pending')).toBeVisible();
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$70');
  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('[data-act="refundcancel"]').click();
  await expect(page.locator('.refund-status-cancelled')).toContainText('Duplicate charge');
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$100');
  await expect(page.locator('#refundamount')).toBeVisible();
});

test('ops can read the booking but cannot load or see money actions', async ({ page }) => {
  const store = { refunds: [] };
  await boot(page, { role: 'ops', store });

  await expect(page.getByText('Refundable remaining')).toHaveCount(0);
  await expect(page.locator('[data-act^="refund"]')).toHaveCount(0);
  expect(store.refundReads).toBe(0);
});
