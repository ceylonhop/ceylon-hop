import { test, expect } from '@playwright/test';

// Payment lookup (spec 2026-09-26, slice 1): a payments:act-only Lookup page in the ops tool.
// Given a booking or quote ref it draws GET /admin/ops/cases/:ref — the customer, a verdict, the
// merged payment timeline and the recording gaps. Offline: whoami, the queue and the case are
// stubbed (server-side 403 enforcement is covered by api's ops.cases.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view'];
const OPS = ['bookings:read', 'bookings:operate'];

const ROW = {
  id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Pay Customer',
  customerFirstName: 'Pay', customerPhone: null, mode: 'single', route: 'Colombo → Kandy',
  travelDate: '2030-01-15', travelTime: '09:00', pax: 2, amount: 10000, currency: 'USD',
  stage: 'awaiting_payment', paymentStatus: 'unpaid', vehiclePhotoReceived: false,
  customerUpdated: false, opsNotes: '', source: 'booking', isTest: false,
};

const DETAIL = {
  booking: {
    id: 'b1', reference: 'CH-0001', mode: 'single', status: 'payment_pending', createdAt: '2026-09-25T08:00:00.000Z',
    input: { customer: { email: 'pay@e2e.test', whatsapp: '+94 77 123 4567', country: 'US' } },
  },
  ops: { fulfilmentStatus: 'awaiting_payment' }, payments: [], payLink: null, coverage: null, checkoutEvents: [],
};

const BOOKING = {
  id: 'b1', reference: 'CH-0001', status: 'payment_pending', mode: 'single', channel: 'website',
  createdAt: '2026-09-25T08:00:00.000Z', route: 'Colombo → Kandy', travelDate: '2030-01-15', travelTime: '09:00', pax: 2,
  total: 10000, amountDueNow: 3000, currency: 'USD',
  customer: { firstName: 'Pay', lastName: 'Customer', email: 'pay@e2e.test', whatsapp: '+94 77 123 4567', country: 'US' },
  billing: { firstName: 'Pay', lastName: 'Customer', address: '', city: 'Austin', country: 'US' },
  termsAcceptedAt: null, cancellation: null, isTest: true, inQueue: true,
};

const VERDICT = {
  kind: 'declined', at: '2026-09-25T08:03:00.000Z', amount: null, currency: 'USD', checkouts: 1, declineNotices: 3,
  countsComplete: true, payhere: { code: '-2', message: 'Insufficient <b>x</b> funds', method: 'VISA', paymentId: '0' },
  manual: null, paidOn: null, captures: null, refund: null, chargebackAt: null, cancellation: null,
  warnings: ['paid_status_without_payment'],
};

const TIMELINE = [
  { at: '2026-09-25T08:00:00.000Z', source: 'bookings', kind: 'created' },
  { at: '2026-09-25T08:01:00.000Z', source: 'booking_checkout_event', kind: 'log', action: 'checkout', outcome: 'succeeded', reason: null, httpStatus: null, attempt: 1, ua: null, client: false, orderMatchOnly: false },
  { at: '2026-09-25T08:01:05.000Z', source: 'payments', kind: 'payment_created', orderId: 'CH-0001', amount: 10000, currency: 'USD' },
  { at: '2026-09-25T08:02:00.000Z', source: 'booking_checkout_event', kind: 'log', action: 'gateway', outcome: 'error', reason: 'Card <b>x</b> declined', httpStatus: null, attempt: null, ua: 'Mozilla/5.0 <b>x</b>', client: true, orderMatchOnly: false },
  { at: '2026-09-25T08:03:00.000Z', source: 'payment_events', kind: 'notice', code: '-2', message: 'Insufficient <b>x</b> funds', method: 'VISA', paymentId: '0', amount: 10000, currency: 'USD', note: null, repeats: 3 },
  { at: '2026-09-25T08:03:02.000Z', source: 'notification_log', kind: 'email', emailKind: 'payment_failed', deliveryTracked: false },
];

const CASE = {
  ref: 'CH-0001', quote: null, booking: BOOKING, verdict: VERDICT, timeline: TIMELINE,
  gaps: ['declines_may_be_missing'], unavailable: [],
};

// Boots the shell with `caps`. `cases` maps the requested ref (as the page sent it) to a stub
// response; every requested case path is recorded so a test can assert what the page asked for.
async function boot(page, caps, cases = {}) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  const requested = [];
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([ROW])));
  await page.route('**/admin/ops/bookings/b1', (r) => r.fulfill(json(DETAIL)));
  // payments:act also loads the refund ledger with the drawer; the catch-all's {} is not a list.
  await page.route('**/admin/bookings/b1/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/cases/**', (r) => {
    const p = new URL(r.request().url()).pathname;
    requested.push(p);
    const hit = cases[decodeURIComponent(p.split('/').pop())];
    return r.fulfill(hit ? json(hit.body, hit.status || 200) : json({ error: 'not_found' }, 404));
  });
  return requested;
}
const ready = (page) => page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
const caseView = (page) => page.locator('[data-testid="lookup-case"]');

test('founder sees Lookup in the nav, between Quotes and Analytics', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE);
  await ready(page);
  await expect(page.locator('[data-testid="lookup-nav"]')).toBeVisible();
  await expect(page.locator('[data-testid="lookup-nav"]')).toHaveAttribute('title', 'Lookup');
  await expect(page.locator('#nav button')).toHaveCount(4);
  expect(await page.locator('#nav button').evaluateAll((bs) => bs.map((b) => b.dataset.route)))
    .toEqual(['tickets', 'quotes', 'lookup', 'analytics']);
});

test('ops: no Lookup nav, and a hand-typed #lookup bounces silently to Bookings', async ({ page }) => {
  const requested = await boot(page, OPS);
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  await expect(page.locator('[data-testid="lookup-nav"]')).toHaveCount(0);
  await expect(page.locator('#view h1')).toHaveText('Bookings');
  expect(new URL(page.url()).hash).toBe('#bookings');
  expect(new URL(page.url()).searchParams.has('case')).toBe(false);
  expect(requested).toEqual([]);
});

test('searching a ref asks the API for exactly that ref and draws header, verdict and timeline in order', async ({ page }) => {
  const requested = await boot(page, FOUNDER, { 'ch-0001': { body: CASE } });
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  await page.locator('[data-testid="lookup-nav"]').click();
  await expect(page.locator('#view h1')).toHaveText('Lookup');
  await expect(page.locator('#view .pagesub')).toHaveText('Payment history for one booking — paste a booking ref (CH-…) or a quote ref (Q-…)');
  await expect(caseView(page)).toHaveCount(0); // no ref → empty state only

  await page.fill('#lookup-q', '  ch-0001 ');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(caseView(page)).toBeVisible();
  expect(requested).toEqual(['/admin/ops/cases/ch-0001']);
  const url = new URL(page.url());
  expect(url.searchParams.get('case')).toBe('ch-0001');
  expect(url.hash).toBe('#lookup');
  await expect(page.locator('#lookup-q')).toHaveValue('ch-0001');

  const head = page.locator('[data-testid="lookup-header"]');
  await expect(head).toContainText('CH-0001');
  await expect(head).toContainText('payment_pending');
  await expect(head).toContainText('Transfer');
  await expect(head).toContainText('Website booking');
  await expect(head).toContainText('Test booking');
  await expect(head).toContainText('Pay Customer');
  await expect(head).toContainText('pay@e2e.test');
  await expect(head.locator('a[href="https://wa.me/94771234567"]')).toHaveText('+94 77 123 4567');
  await expect(head).toContainText('Pay Customer, Austin, US'); // billing: empty parts dropped
  await expect(head).toContainText('Colombo → Kandy');
  await expect(head).toContainText('$100');
  await expect(head).toContainText('$30'); // due now differs from the total
  await expect(head.getByRole('button', { name: 'Open in queue' })).toBeVisible();

  const verdict = page.locator('[data-testid="lookup-verdict"]');
  await expect(verdict.locator('h4')).toHaveText('Payment');
  await expect(verdict.locator('.lk-title')).toHaveText('Declined — still unpaid');
  await expect(verdict).toContainText('1 checkout, 3 decline notices');
  await expect(verdict.locator('.lk-warn')).toHaveText(['The booking says paid, but no payment is recorded.']);

  const rows = page.locator('[data-testid="lookup-timeline"] .pa-row');
  await expect(rows.locator('.lk-label')).toHaveText([
    'Booking created',
    'Checkout started (attempt 1)',
    'Checkout set up — order CH-0001, $100',
    'PayHere error: Card <b>x</b> declined',
    'PayHere: declined — PayHere sent 3 decline notices; repeats share this row',
    'Email: payment didn’t go through',
  ]);
  // Local time to the second on the row, the stored UTC ISO string on hover.
  await expect(rows.nth(0)).toHaveAttribute('title', '2026-09-25T08:00:00.000Z');
  await expect(rows.nth(0).locator('.pa-when')).toHaveText(/^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}:\d{2}$/);
  await expect(rows.nth(5)).toContainText('delivery not tracked');
  await expect(page.locator('[data-testid="lookup-gaps"]')).toContainText('PayHere declines before 26 Sep 2026 may be missing.');
  await expect(caseView(page)).toContainText('Only some customer emails are recorded');

  // "Open in queue" opens the booking's drawer over the page.
  await head.getByRole('button', { name: 'Open in queue' }).click();
  await expect(page.locator('#sheet.show .block h4', { hasText: 'Customer' })).toBeVisible();
});

test('a deep link ?case=…#lookup renders the case and survives a reload', async ({ page }) => {
  const requested = await boot(page, FOUNDER, { 'CH-0001': { body: CASE } });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  await expect(page.locator('[data-testid="lookup-verdict"] .lk-title')).toHaveText('Declined — still unpaid');
  await expect(page.locator('#lookup-q')).toHaveValue('CH-0001');
  await page.reload();
  await ready(page);
  await expect(page.locator('[data-testid="lookup-verdict"] .lk-title')).toHaveText('Declined — still unpaid');
  await expect(page.locator('[data-testid="lookup-nav"]')).toHaveClass(/active/);
  expect(requested).toEqual(['/admin/ops/cases/CH-0001', '/admin/ops/cases/CH-0001']);
  expect(new URL(page.url()).searchParams.get('case')).toBe('CH-0001');
});

test('an unknown ref says so; a bad one says what to type; leaving the page drops ?case=', async ({ page }) => {
  await boot(page, FOUNDER, { 'hello': { body: { error: 'bad_ref' }, status: 400 } });
  await page.goto(OPS_FILE + '?case=CH-NOPE#lookup');
  await ready(page);
  await expect(page.locator('#view')).toContainText('No booking or quote with that reference.');
  await page.fill('#lookup-q', 'hello');
  await page.locator('#lookup-q').press('Enter');
  await expect(page.locator('#view')).toContainText('Enter a booking ref (CH-…) or a quote ref (Q-…).');
  await page.locator('#nav [data-route="tickets"]').click();
  await expect(page.locator('#view h1')).toHaveText('Bookings');
  expect(new URL(page.url()).searchParams.has('case')).toBe(false);
});

test('a source that failed to load makes the verdict "Incomplete", never silently empty', async ({ page }) => {
  await boot(page, FOUNDER, { 'CH-0001': { body: { ...CASE, verdict: null, unavailable: ['refunds'], gaps: [] } } });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  await expect(page.locator('[data-testid="lookup-verdict"]')).toContainText('Incomplete — couldn’t load: refunds');
  await expect(page.locator('[data-testid="lookup-timeline"] .pa-row')).toHaveCount(TIMELINE.length);
});

test('the drawer’s "Payment history →" opens the lookup for that booking (payments:act only)', async ({ page }) => {
  const requested = await boot(page, FOUNDER, { 'CH-0001': { body: CASE } });
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  await page.locator('.tk[data-act="open"][data-id="b1"]').click();
  await expect(page.locator('#sheet .block h4', { hasText: 'Customer' })).toBeVisible();
  const link = page.locator('#sheet .block', { has: page.locator('h4', { hasText: /^Payment$/ }) }).getByRole('button', { name: 'Payment history →' });
  await link.click();
  await expect(page.locator('#view h1')).toHaveText('Lookup');
  await expect(page.locator('[data-testid="lookup-verdict"] .lk-title')).toHaveText('Declined — still unpaid');
  expect(requested).toEqual(['/admin/ops/cases/CH-0001']);
  await expect(page.locator('#sheet')).not.toHaveClass(/show/);
  expect(new URL(page.url()).searchParams.get('case')).toBe('CH-0001');
});

test('an ops session gets no "Payment history →" in the drawer', async ({ page }) => {
  await boot(page, OPS);
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  await page.locator('.tk[data-act="open"][data-id="b1"]').click();
  await expect(page.locator('#sheet .block h4', { hasText: 'Customer' })).toBeVisible();
  await expect(page.locator('#sheet [data-act="lookup"]')).toHaveCount(0);
});

test('markup in PayHere’s message, a reason or a user agent renders as text', async ({ page }) => {
  await boot(page, FOUNDER, { 'CH-0001': { body: CASE } });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  await expect(caseView(page)).toBeVisible();
  await expect(caseView(page).locator('b')).toHaveCount(0);
  await expect(page.locator('[data-testid="lookup-verdict"]')).toContainText('“Insufficient <b>x</b> funds” (code -2)');
  await expect(page.locator('[data-testid="lookup-timeline"]')).toContainText('Mozilla/5.0 <b>x</b>');
});

test('paid on another booking links to that booking’s lookup; a draft is not in the queue', async ({ page }) => {
  const elsewhere = {
    ...CASE,
    booking: { ...BOOKING, status: 'draft', inQueue: false, isTest: false },
    verdict: { ...VERDICT, kind: 'paid_elsewhere', paidOn: 'CH-PAID1', payhere: null, warnings: [] },
  };
  const requested = await boot(page, FOUNDER, { 'CH-0001': { body: elsewhere }, 'CH-PAID1': { body: { ...CASE, ref: 'CH-PAID1' } } });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  const head = page.locator('[data-testid="lookup-header"]');
  await expect(head).toContainText('Not in the queue (draft)');
  await expect(head.getByRole('button', { name: 'Open in queue' })).toHaveCount(0);
  await expect(head).not.toContainText('Test booking');
  await expect(page.locator('[data-testid="lookup-verdict"]')).toContainText('Closed automatically — paid on CH-PAID1');
  await page.locator('[data-testid="lookup-verdict"]').getByRole('button', { name: 'CH-PAID1' }).click();
  await expect(page.locator('#lookup-q')).toHaveValue('CH-PAID1');
  expect(requested).toEqual(['/admin/ops/cases/CH-0001', '/admin/ops/cases/CH-PAID1']);
});

test('a quote with no booking yet says so', async ({ page }) => {
  await boot(page, FOUNDER, { 'Q-7F3KX': { body: {
    ref: 'Q-7F3KX', quote: { id: 'q1', reference: 'Q-7F3KX', status: 'sent' }, booking: null, verdict: null,
    timeline: [], gaps: [], unavailable: [],
  } } });
  await page.goto(OPS_FILE + '?case=Q-7F3KX#lookup');
  await ready(page);
  const view = caseView(page);
  await expect(view).toContainText('Q-7F3KX');
  await expect(view).toContainText('sent');
  await expect(view).toContainText('This quote has no booking yet — the customer hasn’t opened its pay link.');
  await expect(page.locator('[data-testid="lookup-timeline"]')).toHaveCount(0);
});

// Slice 2 (spec §15): the same person's other bookings, newest first, each one press from its own
// lookup. The API sends `otherBookings: {rows, truncated}`, or null when it could not read them.
const OTHER = (over = {}) => ({
  id: 'b2', reference: 'CH-0002', status: 'draft', mode: 'single', channel: 'website',
  createdAt: '2026-09-24T09:00:00.000Z', route: 'Colombo → <b>Ella</b>', travelDate: '2030-02-01', travelTime: '08:00', pax: 2,
  total: 8000, currency: 'USD', paid: false, isTest: false, ...over,
});

test('this customer’s other bookings: newest first, each opens its own lookup', async ({ page }) => {
  const newer = OTHER({ id: 'b3', reference: 'CH-0003', status: 'paid', paid: true, createdAt: '2026-09-25T09:00:00.000Z', isTest: true });
  const requested = await boot(page, FOUNDER, {
    'CH-0001': { body: { ...CASE, otherBookings: { rows: [newer, OTHER()], truncated: false } } },
    'CH-0003': { body: { ...CASE, ref: 'CH-0003', booking: { ...BOOKING, id: 'b3', reference: 'CH-0003' }, otherBookings: { rows: [], truncated: false } } },
  });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  const block = page.locator('[data-testid="lookup-others"]');
  await expect(block.locator('h4')).toHaveText('This customer’s bookings');
  await expect(block.locator('[data-lkcase]')).toHaveText(['CH-0003', 'CH-0002']);
  const lines = block.locator('.lk-other');
  await expect(lines.nth(0)).toContainText('paid');
  await expect(lines.nth(0)).toContainText('test booking');
  await expect(lines.nth(1)).toContainText('draft · unpaid');
  await expect(lines.nth(1)).toContainText('Colombo → <b>Ella</b>'); // shown as text, never parsed
  await expect(block.locator('b')).toHaveCount(0);

  await block.locator('[data-lkcase="CH-0003"]').click();
  await expect(page.locator('[data-testid="lookup-header"]')).toContainText('CH-0003');
  expect(requested).toEqual(['/admin/ops/cases/CH-0001', '/admin/ops/cases/CH-0003']);
  await expect(page.locator('[data-testid="lookup-others"]')).toContainText('No other bookings with this email.');
});

test('other bookings: a truncated list says so, a failed read says so, an answer without the field shows no block', async ({ page }) => {
  await boot(page, FOUNDER, {
    'CH-0001': { body: { ...CASE, otherBookings: { rows: [OTHER()], truncated: true } } },
    'CH-0002': { body: { ...CASE, ref: 'CH-0002', otherBookings: null } },
    'CH-0009': { body: CASE },
  });
  await page.goto(OPS_FILE + '?case=CH-0001#lookup');
  await ready(page);
  await expect(page.locator('[data-testid="lookup-others"]')).toContainText('Showing the newest 50.');

  await page.fill('#lookup-q', 'CH-0002');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(page.locator('[data-testid="lookup-others"]')).toContainText('Couldn’t load this customer’s other bookings.');

  await page.fill('#lookup-q', 'CH-0009');
  await page.getByRole('button', { name: 'Look up' }).click();
  await expect(caseView(page)).toBeVisible();
  await expect(page.locator('[data-testid="lookup-others"]')).toHaveCount(0);
});
