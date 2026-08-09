import { test, expect } from '@playwright/test';
import { futureIsoDate } from '../dates.js';

// Drives the REAL ops shell (api/src/routes/ops-ui.html) offline (stubbed API, no DB).
//
// The booking sheet is DIFF-rendered (morphdom), not innerHTML-swapped, so that a queue
// refresh after a toggle or a note cannot throw the operator's scroll position away or eat
// text they are still typing. That buys three invariants which are easy to break by accident:
//
//   1. an UNSENT field survives a re-render (the whole point), but
//   2. a CONSUMED field is cleared by the code that consumed it — otherwise a saved note
//      sits in the box looking unsaved and gets added twice, and
//   3. opening a DIFFERENT booking starts at the top, because the node is now reused.
//
// Plus the race the diff-render surfaced: a post-mutation refetch that lands after the
// operator has moved on must not paint the old booking's data into the new booking's sheet.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

// Mutable so the /flags stub can persist what the UI writes, the way the real API does —
// otherwise a saved note never comes back on the next queue load and the Activity list
// stays empty for reasons that have nothing to do with what is under test.
let opsNotes = { b1: '', b2: '' };

const rows = () => ([
  { id: 'b1', reference: 'CH-0001', channel: 'website', customerName: 'Alpha Customer',
    customerFirstName: 'Alpha', mode: 'single', route: 'Colombo → Kandy',
    travelDate: futureIsoDate(30), travelTime: '09:00', pax: 2, amount: 3900, currency: 'USD',
    stage: 'awaiting_payment', paymentStatus: 'pending', vehiclePhotoReceived: false, customerUpdated: false,
    opsNotes: opsNotes.b1, source: 'booking', board: null },
  { id: 'b2', reference: 'CH-0002', channel: 'whatsapp', customerName: 'Bravo Customer',
    customerFirstName: 'Bravo', mode: 'single', route: 'Galle → Mirissa',
    travelDate: futureIsoDate(31), travelTime: '10:00', pax: 1, amount: 2500, currency: 'USD',
    stage: 'awaiting_payment', paymentStatus: 'pending', vehiclePhotoReceived: false, customerUpdated: false,
    opsNotes: opsNotes.b2, source: 'booking', board: null },
]);

const detail = (id, email) => ({
  payLink: id === 'b1' ? 'https://pay.example.test/PAY-ALPHA' : 'https://pay.example.test/PAY-BRAVO',
  booking: { id, reference: id === 'b1' ? 'CH-0001' : 'CH-0002', currency: 'USD', status: 'awaiting_payment',
    mode: 'single', createdAt: '2026-08-01T00:00:00Z',
    input: { customer: { whatsapp: '+94 11 000 0000', email, country: 'Sri Lanka' } } },
  ops: { updatedAt: '2026-08-02T00:00:00Z' },
  payments: [{ id: 'p1', status: 'succeeded', amount: id === 'b1' ? 3900 : 2500, currency: 'USD' }],
  refunds: [],
});

// delayB1: ms to stall b1's detail GET. `skipFirst` stalls only the REFETCH (the call made
// after a mutation), leaving the initial open fast — that is the path refreshDetail guards.
async function boot(page, { delayB1 = 0, skipFirst = false } = {}) {
  let b1Calls = 0;
  opsNotes = { b1: '', b2: '' };
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  // Catch-all first: Playwright gives precedence to the LAST matching route.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/bookings/*/refunds', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(rows())));
  await page.route('**/admin/ops/bookings/b1', async (r) => {
    b1Calls += 1;
    const stall = delayB1 && (!skipFirst || b1Calls > 1);
    if (stall) await new Promise((res) => setTimeout(res, delayB1));
    r.fulfill(json(detail('b1', 'alpha@example.com')));
  });
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(detail('b2', 'bravo@example.com'))));
  await page.route('**/admin/ops/bookings/*/flags', (r) => {
    const body = r.request().postDataJSON?.() || {};
    const id = /bookings\/(b\d)\/flags/.exec(r.request().url())?.[1];
    if (id && body.opsNotes !== undefined) opsNotes[id] = body.opsNotes;
    r.fulfill(json({ ok: true }));
  });
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({
    email: 'x@e2e.test', role: 'founder', caps: ['bookings:operate', 'payments:act'] })));
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
}

async function open(page, id) {
  await page.locator(`.tk[data-act="open"][data-id="${id}"]`).click();
  await page.waitForSelector('.sheet-b:not(.skel)', { timeout: 10000 });
}

test('a half-typed note and the scroll position both survive a toggle round-trip', async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  await page.locator('#noteinput').fill('driver prefers the coast road');
  await page.evaluate(() => { document.querySelector('.sheet-b').scrollTop = 200; });
  // click via page JS: locator.click() would scroll the switch into view itself and mask the bug
  await page.evaluate(() => document.querySelector('.switch[data-k="photo"]').click());
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => document.querySelector('.sheet-b').scrollTop)).toBe(200);
  expect(await page.locator('#noteinput').inputValue()).toBe('driver prefers the coast road');
});

test('a note that has been saved is cleared from the composer, so it cannot be added twice', async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  await page.locator('#noteinput').fill('pickup moved to the side gate');
  await page.locator('[data-act="addnote"]').click();
  await page.waitForTimeout(900);
  await expect(page.locator('.sheet-b')).toContainText('pickup moved to the side gate');
  expect(await page.locator('#noteinput').inputValue()).toBe('');
});

test('opening a different booking starts at the top of the sheet', async ({ page }) => {
  await boot(page);
  await open(page, 'b1');
  await page.evaluate(() => { document.querySelector('.sheet-b').scrollTop = 300; });
  await page.keyboard.press('Escape');
  await open(page, 'b2');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => document.querySelector('.sheet-b').scrollTop)).toBe(0);
});

// Both of these fail — Alpha's email rendered inside Bravo's sheet — if the corresponding
// assignment to state.detailData is left unguarded. They cover the two different fetches
// that can land late, which is why neither one alone is enough.

test('a slow POST-MUTATION refetch never paints the previous booking into the open one', async ({ page }) => {
  // The initial open is fast; only the refetch that follows the toggle stalls. While it is in
  // flight the operator moves to b2 — then the late b1 payload lands and refreshRow() renders.
  await boot(page, { delayB1: 1200, skipFirst: true });
  await open(page, 'b1');
  await page.evaluate(() => document.querySelector('.switch[data-k="photo"]').click());
  await page.waitForTimeout(150);            // POST is away, refetch is stalling
  await page.keyboard.press('Escape');
  await open(page, 'b2');
  await page.waitForTimeout(2000);           // b1's refetch resolves and re-renders in here
  await expect(page.locator('#sheet')).toContainText('Bravo Customer');
  await expect(page.locator('.sheet-b')).toContainText('bravo@example.com');
  await expect(page.locator('.sheet-b')).not.toContainText('alpha@example.com');
});

test('an abandoned initial load cannot put the wrong customer’s pay link on the clipboard', async ({ page }) => {
  // openDetail's fetch is the other late-lander, and its damage needs NO re-render to surface:
  // "Copy payment reminder" reads state.detailData.payLink directly. Left unguarded, an
  // abandoned load for b1 overwrites it, and Bravo is sent Alpha's payment link.
  await boot(page, { delayB1: 1500 });
  await page.addInitScript(() => {
    window.__copied = [];
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: (t) => { window.__copied.push(t); return Promise.resolve(); } },
    });
  });
  await page.reload();
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });

  await page.locator('.tk[data-act="open"][data-id="b1"]').click();
  await page.waitForSelector('.sheet-b.skel', { timeout: 3000 });
  await page.keyboard.press('Escape');
  await open(page, 'b2');
  await page.waitForTimeout(2200);           // b1's abandoned load resolves in here
  await page.locator('[data-act="payreminder"]').click();
  await page.waitForTimeout(200);

  const copied = await page.evaluate(() => window.__copied.join('\n'));
  expect(copied).toContain('PAY-BRAVO');
  expect(copied).not.toContain('PAY-ALPHA');
});
