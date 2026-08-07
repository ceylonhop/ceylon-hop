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

async function boot(page, { role = 'finance', store, mobile = false, travelDate } = {}) {
  if (mobile) await page.setViewportSize({ width: 390, height: 844 });
  // payments:act reads the ledger (founder + finance); payments:reverse starts/confirms a
  // refund and is FOUNDER ONLY since 2026-08-02.
  const paymentsAct = role === 'founder' || role === 'finance';
  // Mirrors lib/opsAuth.ts exactly. finance has NO bookings:operate — it records money, it
  // does not run bookings — so the 24-hour reversal grant never reaches it.
  const caps = [
    'bookings:read',
    ...(role === 'finance' ? [] : ['bookings:operate']),
    ...(paymentsAct ? ['payments:act'] : []),
    ...(role === 'founder' ? ['payments:reverse'] : []),
  ];
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
  const theRow = travelDate ? { ...row, travelDate } : row;
  await page.route('**/admin/ops/bookings', (route) => route.fulfill(json([theRow])));
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
  // The API path: POST .../execute calls PayHere's Refund API server-side. `store.executeOutcome`
  // decides what PayHere "said", so one mock covers success, decline and the indeterminate 202.
  await page.route(/\/admin\/bookings\/booking-1\/refunds\/([^/]+)\/execute$/, async (route) => {
    const match = new URL(route.request().url()).pathname.match(/refunds\/([^/]+)\/execute$/);
    const refund = store.refunds.find((item) => item.id === match[1]);
    store.executePosts = (store.executePosts || 0) + 1;
    if (store.executeOutcome === 'failed') {
      Object.assign(refund, { status: 'api_failed', providerMessage: 'Error processing refund' });
      return route.fulfill(json({ error: 'refund_declined', refund }, 409));
    }
    if (store.executeOutcome === 'unknown') {
      Object.assign(refund, { status: 'api_processing' });
      return route.fulfill(json(
        { error: 'refund_outcome_unknown', refundId: refund.id, providerMessage: 'timed out' },
        202,
      ));
    }
    Object.assign(refund, {
      status: 'api_confirmed',
      gatewayRef: 'PH-API-778899',
      confirmedBy: store.email,
      confirmedAt: '2030-01-02T10:06:00.000Z',
    });
    return route.fulfill(json({ refund, bookingFullyRefunded: true }));
  });

  await page.goto(OPS_FILE);
  await page.locator('[data-act="open"][data-id="booking-1"]').click();
  await expect(page.locator('#sheet')).toHaveClass(/show/);
}

test('the founder requests, reloads, and confirms a refund exactly once with PayHere evidence', async ({ page }) => {
  const store = { refunds: [] };
  // One handler for the whole test. Every confirm() here is meant to be accepted, and `once`
  // left the double-press's SECOND dialog unhandled — Playwright auto-dismissed it, and on a
  // slow pass that landed before the first request had rendered its row. The single-POST
  // guarantee is refundBusy's job; store.requestPosts below is what actually proves it.
  page.on('dialog', (dialog) => dialog.accept());
  await boot(page, { role: 'founder', store });

  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$100');
  // No amount box: the refund is always the FULL remainder, because our PayHere setup cannot
  // do partials (owner, 2026-08-02). Double-press still yields exactly one POST.
  await expect(page.locator('#refundamount')).toHaveCount(0);
  const request = page.locator('[data-act="refundrequest"]');
  await expect(request).toContainText('$100');
  // A reason is required for both reversal actions now (owner rule 2026-08-02) and is stored
  // against the refund — without it the request is refused client-side and never POSTs.
  await page.locator('#reversereason').fill('Customer cancelled — airline strike');
  await request.dispatchEvent('click');
  await request.dispatchEvent('click');

  await expect(page.locator('.refund-status-manual_pending')).toContainText('$100');
  expect(store.requestPosts).toBe(1);
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$0');

  await page.reload();
  await page.locator('[data-act="open"][data-id="booking-1"]').click();
  // The reason is the operator's own words now, and it survives a reload because it is stored
  // on the refund rather than being a label the button supplied.
  await expect(page.locator('.refund-status-manual_pending')).toContainText('Customer cancelled — airline strike');
  // The manual dashboard-and-paste route is still here, but it is now the alternative to the
  // API button rather than the only way through — hence "Or refund it by hand".
  await expect(page.getByText('Or refund it by hand in the PayHere dashboard')).toBeVisible();

  await page.locator('[data-refund-ref="refund-1"]').fill('PAYHERE-R-1001');
  await page.locator('[data-act="refundconfirm"]').click();
  await expect(page.locator('.refund-status-manual_confirmed')).toContainText('PAYHERE-R-1001');
  await expect(page.locator('.refund-status-manual_confirmed')).toContainText('founder@e2e.test');
  await expect(page.locator('.block', { hasText: 'Activity' })).toContainText('Refund confirmed · $100');
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
  // The balance is available again, so the full-amount button comes back — no amount box.
  await expect(page.locator('[data-act="refundrequest"]')).toContainText('$100');
  await expect(page.locator('#refundamount')).toHaveCount(0);
});

test('finance can read the refund ledger but cannot start or confirm a refund', async ({ page }) => {
  const store = { refunds: [] };
  await boot(page, { role: 'finance', store });
  await expect(page.getByText('Refundable remaining')).toBeVisible(); // reconciliation still works
  await expect(page.locator('[data-act="refundrequest"]')).toHaveCount(0);
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
});

// Owner rule 2026-08-02: ops MAY cancel/refund up to 24h before the trip. This fixture travels
// in 2030, so ops is well outside the window and the actions are live for them.
test('ops may reverse a far-off trip, but still cannot read the refund ledger', async ({ page }) => {
  const store = { refunds: [] };
  await boot(page, { role: 'ops', store });

  await expect(page.locator('[data-act="cancelbooking"]')).toBeVisible();
  // The LEDGER is payments:act — reading refund history is a finance/founder concern, and ops
  // must not even fetch it.
  await expect(page.getByText('Refundable remaining')).toHaveCount(0);
  expect(store.refundReads).toBe(0);
});

/* ── the PayHere Refund API path ────────────────────────────────────────────────────────────
   Until PayHere whitelisted our server IPs (2026-08-07) the API path existed server-side with
   no way to reach it from the dashboard, and refundHtmlFor knew only the three manual statuses
   — so every api_* row rendered as "Cancelled" and refundSummary counted none of them as money
   spoken for. These specs pin both halves: the button, and the balance arithmetic. ── */

function apiRefund(status, extra = {}) {
  return {
    ...makeRefund({ refunds: [], email: 'founder@e2e.test' }, 10000, 'Trip called off'),
    status,
    ...extra,
  };
}

test('the founder refunds through PayHere directly and the row reads Confirmed, not Cancelled', async ({ page }) => {
  const store = { refunds: [] };
  page.on('dialog', (dialog) => dialog.accept());
  await boot(page, { role: 'founder', store });

  await page.locator('#reversereason').fill('Customer cancelled — airline strike');
  await page.locator('[data-act="refundrequest"]').dispatchEvent('click');
  await expect(page.locator('.refund-status-manual_pending')).toBeVisible();

  const execute = page.locator('[data-act="refundexecute"]');
  await expect(execute).toBeVisible();
  await execute.dispatchEvent('click');
  await execute.dispatchEvent('click'); // refundBusy must collapse this to one call

  const done = page.locator('.refund-status-api_confirmed');
  await expect(done).toContainText('Confirmed');
  await expect(done).toContainText('PH-API-778899');
  await expect(done).not.toContainText('Cancelled');
  expect(store.executePosts).toBe(1);
  // No dashboard-and-paste step: the API supplied the evidence itself.
  await expect(page.locator('[data-refund-ref="refund-1"]')).toHaveCount(0);
});

test('an API-confirmed refund spends the balance, so the sheet does not re-offer it', async ({ page }) => {
  // The bug this pins: refundSummary counted only manual_confirmed, so a booking already
  // refunded in full through the API read as fully refundable and showed the button again.
  const store = { refunds: [apiRefund('api_confirmed', { gatewayRef: 'PH-API-778899' })] };
  await boot(page, { role: 'founder', store });

  await expect(page.getByText('Previously refunded').locator('..').locator('.v')).toHaveText('$100');
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$0');
  await expect(page.locator('[data-act="refundrequest"]')).toHaveCount(0);
});

test('a refund in flight reserves the money and offers no buttons', async ({ page }) => {
  const store = { refunds: [apiRefund('api_processing')] };
  await boot(page, { role: 'founder', store });

  const row = page.locator('.refund-status-api_processing');
  await expect(row).toContainText('Processing at PayHere');
  await expect(row).not.toContainText('Cancelled');
  // api_processing is the state the whole design exists for: the money MAY have moved, so the
  // dashboard must not offer a retry. A human reconciles it against PayHere.
  await expect(page.getByText('Check PayHere before doing anything else')).toBeVisible();
  await expect(page.locator('[data-act="refundexecute"]')).toHaveCount(0);
  await expect(page.locator('[data-act="refundconfirm"]')).toHaveCount(0);
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$0');
});

test('a declined refund explains itself and hands the balance back', async ({ page }) => {
  const store = { refunds: [apiRefund('api_failed', { providerMessage: 'Error processing refund' })] };
  await boot(page, { role: 'founder', store });

  const row = page.locator('.refund-status-api_failed');
  await expect(row).toContainText('Failed');
  await expect(row).toContainText('Error processing refund'); // not a bare status code
  // api_failed reserves nothing — PayHere told us the money definitely did not move.
  await expect(page.getByText('Refundable remaining').locator('..').locator('.v')).toHaveText('$100');
  await expect(page.locator('[data-act="refundrequest"]')).toBeVisible();
});

test('finance can see an API refund but cannot fire one', async ({ page }) => {
  const store = { refunds: [apiRefund('manual_pending')] };
  await boot(page, { role: 'finance', store });

  await expect(page.locator('.refund-status-manual_pending')).toBeVisible();
  await expect(page.locator('[data-act="refundexecute"]')).toHaveCount(0);
});

test('ops is locked out once the trip is inside 24 hours', async ({ page }) => {
  const store = { refunds: [] };
  const today = new Date().toISOString().slice(0, 10);
  await boot(page, { role: 'ops', store, travelDate: today });

  // The button is shown but inert, with the reason why — not silently absent.
  await expect(page.locator('[data-act="cancelbooking"]')).toHaveCount(0);
  await expect(page.getByText('only a founder can cancel or refund')).toBeVisible();
  await expect(page.locator('#reversereason')).toHaveCount(0);
});
