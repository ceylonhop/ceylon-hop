import { test, expect } from '@playwright/test';

// Ops sees the open balance of a deposit booking and can copy the pay link to resend it (spec
// 2026-10-07 §5.4, rev. 2026-10-08). Offline: every /admin/** call is stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const PAY_LINK = 'https://pay.example/p?t=SIGNED-TOKEN';

const row = (over = {}) => ({
  id: 'booking-1', reference: 'CH-BAL01', channel: 'website', customerName: 'Deposit Traveller', customerFirstName: 'Deposit',
  mode: 'single', route: 'Colombo → Galle', travelDate: '2030-01-15', travelTime: '09:00', pax: 2,
  amount: 21900, currency: 'USD', stage: 'paid', paymentStatus: 'paid', paidCents: 5000, balanceCents: 16900,
  vehiclePhotoReceived: true, customerUpdated: true, opsNotes: '', ...over,
});
const detail = (over = {}) => ({
  booking: { id: 'booking-1', reference: 'CH-BAL01', mode: 'single', status: 'paid', total: 21900, currency: 'USD', createdAt: '2030-01-01T10:00:00.000Z',
    input: { from: 'Colombo', to: 'Galle', customer: { firstName: 'Deposit', lastName: 'Traveller', email: 'd@example.com', whatsapp: '+94770000000', country: 'Sri Lanka' } } },
  ops: {},
  payments: [{ id: 'p-1', bookingId: 'booking-1', provider: 'payhere', orderId: 'CH-BAL01-D', amount: 5000, currency: 'USD', status: 'succeeded', purpose: 'deposit' }],
  balancePayLink: PAY_LINK,
  ...over,
});

async function boot(page, { theRow = row(), theDetail = detail(), open = true } = {}) {
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['bookings:read', 'bookings:operate'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([theRow])));
  await page.route('**/admin/ops/bookings/booking-1', (r) => r.fulfill(json(theDetail)));
  await page.goto(OPS_FILE);
  if (open) {
    await page.locator('[data-act="open"][data-id="booking-1"]').click();
    await expect(page.locator('#sheet')).toHaveClass(/show/);
  }
}

test('the list row carries a "Balance $169" pill', async ({ page }) => {
  await boot(page, { open: false });
  await expect(page.locator('.tk .pill-bal')).toHaveText('Balance $169');
});

test('a fully paid row has no balance pill', async ({ page }) => {
  await boot(page, { theRow: row({ paidCents: 21900, balanceCents: 0 }), open: false });
  await expect(page.locator('.tk')).toHaveCount(1);
  await expect(page.locator('.tk .pill-bal')).toHaveCount(0);
});

// Before any payment balanceDueCents is total − amountDueNow (spec §4), so a deposit attempt the
// customer abandoned carries balanceCents too. Nothing is paid — no "Balance" pill (review #959).
test('an unpaid deposit attempt has no balance pill', async ({ page }) => {
  await boot(page, { theRow: row({ stage: 'awaiting_payment', paymentStatus: 'unpaid', paidCents: 0, balanceCents: 16900 }), open: false });
  await expect(page.locator('.tk')).toHaveCount(1);
  await expect(page.locator('.tk .pill-bal')).toHaveCount(0);
});

test('a balance still open on the day of travel is an attention reason on the row', async ({ page }) => {
  await boot(page, { theRow: row({ travelDate: isoOf(new Date()) }), open: false });
  await expect(page.locator('.tk .reason')).toHaveText('Balance due — travels today');
});

// The open balance in the drawer (owner, 2026-10-12: the copy button was "easy to miss" — "a better
// visual indicator the balance is still due"). One amber card at the top of the Payment block says
// what is owed and carries the link as its primary action; the header repeats the row's tag so the
// balance is visible without scrolling.
const payBlock = (page) => page.locator('#sheet .block', { has: page.locator('h4', { hasText: 'Payment' }) });
const balCard = (page) => payBlock(page).locator('.followup.bal-card');
const headTag = (page) => page.locator('#sheet .sheet-h .pill.pill-bal');

test('the drawer leads the Payment block with a Balance due card, above the ledger rows', async ({ page }) => {
  await boot(page);
  const pay = payBlock(page);
  await expect(balCard(page)).toHaveCount(1);
  await expect(balCard(page).locator('b')).toHaveText('Balance due · $169');
  await expect(balCard(page)).toContainText('Deposit of $50 paid. The customer pays the rest on the link they already have.');
  // The link is the card's primary action, not a plain grey button under the rows.
  const btn = balCard(page).locator('[data-act="balancelink"]');
  await expect(btn).toHaveText('Balance payment link');
  await expect(btn).toHaveClass(/\bbtn-go\b/);
  // First thing in the block after its heading.
  await expect(pay.locator('h4 + *')).toHaveClass(/bal-card/);
  // Nothing is said twice: the card replaced the "Balance due" row and the helper paragraph.
  await expect(pay.locator('.kv .k', { hasText: 'Balance due' })).toHaveCount(0);
  await expect(pay).not.toContainText('any time before the trip');
  // The ledger rows stay.
  await expect(pay.getByText('Amount', { exact: true }).locator('..').locator('.v')).toHaveText('$219');
  await expect(pay.getByText('Paid so far').locator('..').locator('.v')).toHaveText('$50');
  await expect(pay.getByText('Status', { exact: true }).locator('..').locator('.v')).toHaveText('Deposit paid');
  await expect(pay.getByText('Channel', { exact: true })).toHaveCount(1);
});

test('the sheet header carries the same "Balance $169" tag as the list row', async ({ page }) => {
  await boot(page);
  await expect(headTag(page)).toHaveText('Balance $169');
  // Beside the stage pill, which is still there.
  await expect(page.locator('#sheet .sheet-h .idrow .pill')).toHaveCount(2);
});

test('Balance payment link copies the booking’s balancePayLink and says so', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await boot(page);
  await page.locator('[data-act="balancelink"]').click();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PAY_LINK);
  await expect(page.locator('#toast')).toHaveClass(/show/);
  await expect(page.locator('#toast')).toHaveText('Balance payment link copied');
});

// A booking that did not come from a quote has no pay link to resend — the balance is still owed,
// so the card and the tag still say so; only the button is absent.
test('a balance with no link to resend: the card and the tag show, without the button', async ({ page }) => {
  await boot(page, { theDetail: detail({ balancePayLink: null }) });
  await expect(balCard(page).locator('b')).toHaveText('Balance due · $169');
  await expect(headTag(page)).toHaveText('Balance $169');
  await expect(page.locator('[data-act="balancelink"]')).toHaveCount(0);
  await expect(balCard(page).locator('button')).toHaveCount(0);
});

test('no balance, no card: a fully paid booking offers no pay link and no tag', async ({ page }) => {
  await boot(page, { theRow: row({ paidCents: 21900, balanceCents: 0 }), theDetail: detail({ balancePayLink: null }) });
  await expect(page.locator('[data-act="balancelink"]')).toHaveCount(0);
  await expect(balCard(page)).toHaveCount(0);
  await expect(headTag(page)).toHaveCount(0);
  await expect(page.locator('#sheet .sheet-h .idrow .pill')).toHaveCount(1);
  const pay = payBlock(page);
  await expect(pay.getByText('Status', { exact: true }).locator('..').locator('.v')).toHaveText('Paid');
  await expect(pay.getByText('Balance due')).toHaveCount(0);
});

// Nothing is paid yet: balanceCents is the planned split (spec §4), not money owed on a deposit.
test('an unpaid booking gets neither the card nor the tag', async ({ page }) => {
  await boot(page, {
    theRow: row({ stage: 'awaiting_payment', paymentStatus: 'unpaid', paidCents: 0, balanceCents: 16900 }),
    theDetail: detail({ booking: { ...detail().booking, status: 'payment_pending' }, payments: [], balancePayLink: null }),
  });
  await expect(payBlock(page)).toHaveCount(1);
  await expect(balCard(page)).toHaveCount(0);
  await expect(headTag(page)).toHaveCount(0);
  await expect(payBlock(page).getByText('Status', { exact: true }).locator('..').locator('.v')).toHaveText('Awaiting payment');
});
