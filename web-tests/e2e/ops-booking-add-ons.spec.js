import { test, expect } from '@playwright/test';

// Add-ons after booking, in the ops booking pane (spec 2026-11-14 §7.2, §6.5; plan
// 2026-11-15 Task 6). Drives the REAL ops shell (api/src/routes/ops-ui.html) offline: every
// /admin/** call is stubbed, and the stubs answer in the shapes api/src/services/addOns.ts returns.
// Clicks are real clicks (not dispatchEvent) so a button that a re-render detaches would fail here.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const pad = (n) => String(n).padStart(2, '0');
const isoOf = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Travel days are counted from today, and every fixed timestamp is in the past, so nothing here
// can go stale (unit/no-date-bombs.test.js).
const day = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return isoOf(d); };

const OPS = ['bookings:read', 'bookings:operate'];
const FINANCE = ['bookings:read', 'payments:act'];
const FOUNDER = ['bookings:read', 'bookings:operate', 'payments:act', 'payments:reverse'];

const L1 = '11111111-1111-4111-8111-111111111111'; // Negombo → Kandy, already driven
const L2 = '22222222-2222-4222-8222-222222222222'; // Kandy → Ella
const L3 = '33333333-3333-4333-8333-333333333333'; // Ella → Yala, the customer's own stretch
const L4 = '44444444-4444-4444-8444-444444444444'; // Yala → Mirissa
const L5 = '55555555-5555-4555-8555-555555555555'; // Mirissa → Galle, no date yet
const LEGS = [
  { id: L1, seq: 1, kind: 'leg', from: 'Negombo', to: 'Kandy', viaStops: [], travelDate: day(-2) },
  { id: L2, seq: 2, kind: 'leg', from: 'Kandy, Sri Lanka', to: 'Ella', viaStops: [], travelDate: day(5) },
  { id: L3, seq: 3, kind: 'gap', from: 'Ella', to: 'Yala', viaStops: [], travelDate: null },
  { id: L4, seq: 4, kind: 'leg', from: 'Yala', to: 'Mirissa', viaStops: [], travelDate: day(9) },
  { id: L5, seq: 5, kind: 'leg', from: 'Mirissa', to: 'Galle', viaStops: [], travelDate: null },
];
// The live rate card as the API hands it over. "Child seat" is the API's label for `front`; the
// pane's own EXTRA_LBL map calls it "Front seat", so seeing "Child seat" proves where labels come from.
const CAT = [
  { code: 'sightseeing', label: 'Sightseeing stops (up to 3h)', priceCents: 1000 },
  { code: 'safari-wait', label: 'Wait for Safari', priceCents: 1900 },
  { code: 'luggage', label: 'Luggage rack', priceCents: 500 },
  { code: 'front', label: 'Child seat', priceCents: 800 },
  { code: 'flex', label: 'Flexi ticket', priceCents: 1200 },
  { code: 'waiting', label: 'Waiting fee', priceCents: 1000 },
];
const PAY_LINK = 'https://ceylonhop.example/manage.html?t=SIGNED#add-ons';
const CUSTOMER = { firstName: 'Anna', lastName: 'Keller', email: 'anna@example.com', whatsapp: '+4915112345678', country: 'Germany' };

const line = (n, legId, code, label, amountCents) => ({ id: `line-${n}`, legId, code, label, amountCents });
const SIGHT_L2 = line(1, L2, 'sightseeing', 'Sightseeing stops (up to 3h) — Kandy → Ella', 1000);
const req = (seq, over = {}) => ({
  id: `req-${seq}`, seq, name: `A${seq}`, status: 'open', state: 'awaiting_payment', totalCents: 1000, currency: 'USD',
  orderId: `CH-V72WB-A${seq}`, payable: true, payLink: PAY_LINK, inFlightUntil: null, refundedCents: 0, paymentId: null,
  createdBy: 'o@x.com', createdAt: '2026-11-12T13:08:46.313Z', paidAt: null,
  cancelledBy: null, cancelledAt: null, cancelReason: null, lines: [SIGHT_L2], ...over,
});
const TRIP_PAYMENT = { id: 'pay-trip', bookingId: 'b1', provider: 'payhere', orderId: 'CH-V72WB', amount: 23600, currency: 'USD', status: 'succeeded', purpose: 'full' };

const row = (over = {}) => ({
  id: 'b1', reference: 'CH-V72WB', channel: 'whatsapp', customerName: 'Anna Keller', customerFirstName: 'Anna',
  mode: 'trip', route: 'Negombo → Kandy → Ella → Yala → Mirissa → Galle', travelDate: day(5), travelTime: null, pax: 2,
  amount: 23600, currency: 'USD', stage: 'paid', paymentStatus: 'paid',
  vehiclePhotoReceived: false, customerUpdated: false, opsNotes: '', ...over,
});
const detail = (over = {}) => ({
  booking: {
    id: 'b1', reference: 'CH-V72WB', mode: 'trip', status: 'confirmed', total: 23600, currency: 'USD', createdAt: '2026-11-09T08:00:00.000Z',
    addOns: ['Waiting fee — Negombo → Kandy'],
    input: { serviceType: 'private', pax: 2, vehicleType: 'car', customer: CUSTOMER,
      stops: ['Negombo', 'Kandy', 'Ella', 'Yala', 'Mirissa', 'Galle'], dates: [day(-2), day(5), null, day(9), null], gaps: [2] },
  },
  ops: {}, payments: [TRIP_PAYMENT], legs: LEGS, addOnRequests: [], addOnCatalogue: CAT, ...over,
});
// A one-leg private transfer that bought the waiting fee when it was booked.
const singleDetail = () => ({
  booking: {
    id: 'b1', reference: 'CH-V72WB', mode: 'single', status: 'paid', total: 9000, currency: 'USD', createdAt: '2026-11-09T08:00:00.000Z',
    addOns: ['Waiting fee'],
    input: { from: 'Kandy', to: 'Ella', date: day(5), time: '08:00', vehicleType: 'car', adults: 2, children: 0, bags: 2, customer: CUSTOMER },
  },
  ops: {}, payments: [{ ...TRIP_PAYMENT, amount: 9000 }],
  legs: [{ id: L2, seq: 1, kind: 'leg', from: 'Kandy', to: 'Ella', viaStops: [], travelDate: day(5) }],
  addOnRequests: [], addOnCatalogue: CAT,
});

// `store.detail` is what GET /admin/ops/bookings/b1 answers NOW: a test swaps it inside a POST
// stub, exactly as the server's next read would differ after the write.
async function boot(page, store, { caps = OPS, rows = [row()], stage = null } = {}) {
  store.posts = []; store.cancels = []; store.reads = 0;
  store.refunds = store.refunds || [];
  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'o@x.com', role: 'ops', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json(rows)));
  await page.route('**/admin/bookings/b1/refunds', (r) => r.fulfill(json(store.refunds)));
  await page.route('**/admin/ops/bookings/b1', (r) => { store.reads++; return r.fulfill(json(store.detail)); });
  await page.route('**/admin/ops/bookings/b1/add-ons', async (r) => {
    store.posts.push(r.request().postDataJSON());
    const reply = store.onCreate ? await store.onCreate() : { status: 200, body: { request: req(1), emailed: true } };
    return r.fulfill(json(reply.body, reply.status));
  });
  await page.route('**/admin/ops/bookings/b1/add-ons/*/cancel', async (r) => {
    store.cancels.push({ url: new URL(r.request().url()).pathname, body: r.request().postDataJSON() });
    const reply = store.onCancel ? await store.onCancel() : { status: 200, body: { request: req(1, { status: 'cancelled', state: 'cancelled' }) } };
    return r.fulfill(json(reply.body, reply.status));
  });
  await page.goto(OPS_FILE + '#bookings');
  await page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
  // "All open" hides closed rows; the Closed chip is where a cancelled booking lives.
  if (stage === 'closed') await page.locator('.fchip[data-g="done"]').click();
  await page.locator('.tk[data-act="open"][data-id="b1"]').click();
  await page.waitForSelector('#sheet.show .sheet-b:not(.skel)', { timeout: 10000 });
  // The sheet slides in. Let it land before anything is clicked, so a press and its release
  // cannot fall on different things.
  await page.locator('#sheet').evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished)));
}

const itinerary = (page) => page.locator('#sheet [data-testid="sheet-itinerary"]');
const section = (page) => itinerary(page).locator('[data-testid="sheet-addons"]');
const card = (page, name) => section(page).locator(`[data-testid="addon-request"][data-request="${name}"]`);
const pill = (page, name) => card(page, name).locator('[data-testid="addon-state"]');
const addBtn = (page) => section(page).locator('[data-act="addonopen"]', { hasText: '+ Add-on' });
const form = (page) => section(page).locator('[data-testid="addon-form"]');
const legRow = (page, text) => form(page).locator('[data-testid="addon-leg"]', { hasText: text });
const opt = (page, leg, label) => legRow(page, leg).locator('label.ao-opt', { hasText: label });
const sendBtn = (page) => form(page).locator('[data-act="addonsend"]');
const toast = (page) => page.locator('#toast');
const fold = (page, k) => page.locator(`#sheet details.fold[data-fold="${k}"]`);
// The pane's own date words, so the assertions do not depend on this machine's locale data.
const fmtFull = (page, iso) => page.evaluate((d) => fmtFull(d), iso);
const fmtDateTime = (page, iso) => page.evaluate((d) => fmtDateTime(d), iso);
const hhmm = (page, iso) => page.evaluate((s) => { const d = new Date(s); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); }, iso);

test.describe('the Add-ons section', () => {
  test('sits under the legs: add-ons booked with the trip, then one card per request', async ({ page }) => {
    const twoLines = req(2, {
      status: 'paid', state: 'paid', totalCents: 2000, payable: false, payLink: null, paidAt: '2026-11-12T14:05:00.000Z', paymentId: 'pay-a2',
      lines: [line(2, L2, 'waiting', 'Waiting fee — Kandy → Ella', 1000), line(3, L4, 'waiting', 'Waiting fee — Yala → Mirissa', 1000)],
    });
    const store = { detail: detail({ addOnRequests: [req(1), twoLines] }) };
    await boot(page, store);

    await expect(section(page).locator('h4')).toHaveText('Add-ons');
    // Under the legs, inside the itinerary block.
    const after = await itinerary(page).evaluate((el) => {
      const legs = el.querySelector('.legs'), sec = el.querySelector('[data-testid="sheet-addons"]');
      return !!(legs.compareDocumentPosition(sec) & Node.DOCUMENT_POSITION_FOLLOWING);
    });
    expect(after).toBe(true);

    // What the customer bought when they booked: named, with its leg, and tagged.
    const booked = section(page).locator('[data-testid="addon-booked"]');
    await expect(booked).toHaveCount(1);
    await expect(booked.locator('.ao-name')).toHaveText('Waiting fee');
    await expect(booked.locator('.ao-sub')).toHaveText('Negombo → Kandy');
    await expect(booked.locator('.ao-tag')).toHaveText('Booked with the trip');
    // They are listed once: the old Extras row is this list now.
    await expect(itinerary(page).locator('.kv .k', { hasText: 'Extras' })).toHaveCount(0);

    // Request A1: its line, its leg and day, its price, its state and who sent it when.
    const a1 = card(page, 'A1');
    await expect(a1.locator('.ao-line')).toHaveCount(1);
    await expect(a1.locator('.ao-name')).toHaveText('Sightseeing stops (up to 3h)');
    await expect(a1.locator('.ao-line .ao-sub')).toHaveText(`Kandy → Ella · ${await fmtFull(page, day(5))}`);
    await expect(a1.locator('.ao-amt')).toHaveText('$10');
    await expect(pill(page, 'A1')).toHaveText('Awaiting payment');
    await expect(a1.locator('.ao-meta')).toContainText(`Request A1 · sent ${await fmtDateTime(page, '2026-11-12T13:08:46.313Z')} · o@x.com`);
    await expect(a1).toContainText(`Customer can pay until the end of ${await fmtFull(page, day(5))}.`);
    await expect(a1.locator('[data-act="addoncopy"]')).toHaveText('Copy pay link');
    await expect(a1.locator('[data-act="addoncancelopen"]')).toHaveText('Cancel request');
    // One line is its own total; no second figure to read.
    await expect(a1.locator('[data-testid="addon-total"]')).toHaveCount(0);

    // Request A2: two lines under two legs, one total.
    const a2 = card(page, 'A2');
    await expect(a2.locator('.ao-line')).toHaveCount(2);
    await expect(a2.locator('.ao-line .ao-sub').nth(1)).toHaveText(`Yala → Mirissa · ${await fmtFull(page, day(9))}`);
    await expect(a2.locator('[data-testid="addon-total"]')).toHaveText('Total$20');
    await expect(pill(page, 'A2')).toHaveText('Paid');
  });

  test('a booking with no add-ons and nothing to add shows no section at all', async ({ page }) => {
    const d = detail({ addOnRequests: [], addOnCatalogue: undefined });
    d.booking.addOns = [];
    await boot(page, { detail: d });
    await expect(itinerary(page).locator('.legs')).toHaveCount(1);
    await expect(section(page)).toHaveCount(0);
  });

  test('every state has its pill and its own words', async ({ page }) => {
    const until = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const paid = { status: 'paid', payable: false, payLink: null, paidAt: '2026-11-12T14:05:00.000Z' };
    const store = { detail: detail({ addOnRequests: [
      req(1),
      req(2, { inFlightUntil: until, paymentId: 'pay-a2' }),
      req(3, { ...paid, state: 'paid', paymentId: 'pay-a3' }),
      req(4, { state: 'expired', payable: false, payLink: null, lines: [line(4, L1, 'luggage', 'Luggage rack — Negombo → Kandy', 500)], totalCents: 500 }),
      req(5, { status: 'cancelled', state: 'cancelled', payable: false, payLink: null, cancelledBy: 'lead@x.com', cancelledAt: '2026-11-12T15:00:00.000Z', cancelReason: 'Customer changed their mind' }),
      req(6, { state: 'cancelled_with_booking', payable: false, payLink: null }),
      req(7, { ...paid, state: 'part_refunded', refundedCents: 400, paymentId: 'pay-a7' }),
      req(8, { ...paid, state: 'refunded', refundedCents: 1000, paymentId: 'pay-a8' }),
      req(9, { lines: [line(9, L5, 'flex', 'Flexi ticket — Mirissa → Galle', 1200)], totalCents: 1200 }),
    ] }) };
    await boot(page, store);

    const want = { A1: 'Awaiting payment', A2: 'Paying now', A3: 'Paid', A4: 'Expired', A5: 'Cancelled', A6: 'Cancelled with booking', A7: 'Part refunded', A8: 'Refunded', A9: 'Awaiting payment' };
    for (const [name, text] of Object.entries(want)) await expect(pill(page, name), name).toHaveText(text);

    // Paying now: the customer has PayHere open, so Cancel is locked until the time it frees up.
    const a2 = card(page, 'A2');
    await expect(a2.locator('button', { hasText: 'Cancel request' })).toBeDisabled();
    await expect(a2).toContainText(`Can be cancelled after ${await hhmm(page, until)} if they don’t pay.`);
    await expect(a2.locator('[data-act="addoncancelopen"]')).toHaveCount(0);

    // Paid: nothing tells the driver for us.
    await expect(card(page, 'A3')).toContainText('Tell the driver about this add-on.');
    await expect(card(page, 'A3').locator('.ao-meta')).toContainText(`Request A3 · paid ${await fmtDateTime(page, '2026-11-12T14:05:00.000Z')} · CH-V72WB-A3`);
    await expect(card(page, 'A1')).not.toContainText('Tell the driver');

    await expect(card(page, 'A4').locator('.ao-meta')).toContainText(`Request A4 · not paid by the end of ${await fmtFull(page, day(-2))}`);
    await expect(card(page, 'A5').locator('.ao-meta')).toContainText('Request A5 · by lead@x.com · “Customer changed their mind”');
    await expect(card(page, 'A7').locator('.ao-meta')).toContainText('Request A7 · $4 of $10 refunded');
    await expect(card(page, 'A8').locator('.ao-meta')).toContainText('Request A8 · $10 refunded');

    // Only a request that can still be paid offers the link or the cancel.
    for (const name of ['A3', 'A4', 'A5', 'A6', 'A7', 'A8']) {
      await expect(card(page, name).locator('button'), name).toHaveCount(0);
    }
    // A leg with no date yet has no last day to pay by, so the sentence is left out.
    await expect(card(page, 'A9').locator('.ao-line .ao-sub')).toHaveText('Mirissa → Galle');
    await expect(card(page, 'A9')).not.toContainText('Customer can pay until');
    await expect(card(page, 'A9').locator('[data-act="addoncopy"]')).toHaveCount(1);
  });
});

test.describe('who gets "+ Add-on"', () => {
  test('ops, on a booking the API says can take one', async ({ page }) => {
    await boot(page, { detail: detail() });
    await expect(addBtn(page)).toHaveCount(1);
    await expect(addBtn(page)).toBeVisible();
  });

  test('not finance: they see the requests, and cannot add or cancel one', async ({ page }) => {
    await boot(page, { detail: detail({ addOnRequests: [req(1)] }) }, { caps: FINANCE });
    await expect(pill(page, 'A1')).toHaveText('Awaiting payment');
    await expect(addBtn(page)).toHaveCount(0);
    await expect(section(page).locator('button', { hasText: 'Cancel request' })).toHaveCount(0);
    await expect(card(page, 'A1').locator('[data-act="addoncopy"]')).toHaveCount(1);
  });

  test('not on a shared seat', async ({ page }) => {
    const shared = {
      booking: { id: 'b1', reference: 'CH-V72WB', mode: 'shared', status: 'paid', total: 3800, currency: 'USD', createdAt: '2026-11-09T08:00:00.000Z',
        input: { fromPlace: 'Kandy', toPlace: 'Ella', date: day(5), time: '08:00', seats: 2, extras: ['hotel-pickup'], customer: CUSTOMER } },
      ops: {}, payments: [{ ...TRIP_PAYMENT, amount: 3800 }],
      legs: [{ id: L2, seq: 1, kind: 'leg', from: 'Kandy', to: 'Ella', viaStops: [], travelDate: day(5) }],
      addOnRequests: [],
    };
    await boot(page, { detail: shared }, { rows: [row({ mode: 'shared', route: 'Kandy → Ella', amount: 3800 })] });
    await expect(itinerary(page).locator('.legs')).toHaveCount(1);
    await expect(addBtn(page)).toHaveCount(0);
    await expect(form(page)).toHaveCount(0);
  });

  test('not when the API sends no catalogue', async ({ page }) => {
    await boot(page, { detail: detail({ addOnCatalogue: undefined, addOnRequests: [req(1)] }) });
    await expect(pill(page, 'A1')).toHaveText('Awaiting payment');
    await expect(addBtn(page)).toHaveCount(0);
  });
});

test.describe('the tick-box form', () => {
  test('lists only the legs the API returned that can take an add-on, with the API’s labels and prices', async ({ page }) => {
    const store = { detail: detail() };
    await boot(page, store);
    await addBtn(page).click();
    await expect(form(page)).toContainText('New add-on request');
    await expect(form(page)).toContainText('Today’s rate-card prices. One of each add-on per leg.');

    // Three of the five stored legs: not the one already driven, not the customer's own stretch.
    const rows = form(page).locator('[data-testid="addon-leg"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('[data-act="addonleg"]')).toContainText(`Kandy → Ella · ${await fmtFull(page, day(5))}`);
    await expect(rows.nth(1).locator('[data-act="addonleg"]')).toContainText(`Yala → Mirissa · ${await fmtFull(page, day(9))}`);
    await expect(rows.nth(2).locator('[data-act="addonleg"]')).toContainText('Mirissa → Galle');
    await expect(form(page)).not.toContainText('Negombo');
    await expect(form(page)).not.toContainText('Ella → Yala');
    // Closed until opened, and each says so.
    for (let i = 0; i < 3; i++) await expect(rows.nth(i).locator('[data-act="addonleg"]')).toContainText('Show add-ons');
    await expect(form(page).locator('label.ao-opt:visible')).toHaveCount(0);

    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
    const opts = legRow(page, 'Kandy → Ella').locator('label.ao-opt');
    await expect(opts).toHaveCount(6);
    await expect(opts).toHaveText(['Sightseeing stops (up to 3h)$10', 'Wait for Safari$19', 'Luggage rack$5', 'Child seat$8', 'Flexi ticket$12', 'Waiting fee$10']);
    await expect(opts.first()).toBeVisible();
    // The other legs stay shut.
    await expect(legRow(page, 'Yala → Mirissa').locator('label.ao-opt').first()).toBeHidden();

    // What was booked with the trip stays in view above the form.
    await expect(section(page).locator('[data-testid="addon-booked"]')).toBeVisible();

    // Nothing ticked: nothing to send.
    await expect(sendBtn(page)).toHaveText('Send request');
    await expect(sendBtn(page)).toBeDisabled();
    await opt(page, 'Kandy → Ella', 'Luggage rack').locator('input').check();
    await expect(sendBtn(page)).toHaveText('Send request · $5');
    await expect(sendBtn(page)).toBeEnabled();
    await opt(page, 'Kandy → Ella', 'Luggage rack').locator('input').uncheck();
    await expect(sendBtn(page)).toHaveText('Send request');
    await expect(sendBtn(page)).toBeDisabled();
    expect(store.posts).toEqual([]);

    // Cancel shuts the form and sends nothing.
    await form(page).locator('[data-act="addonopen"]', { hasText: 'Cancel' }).click();
    await expect(form(page)).toHaveCount(0);
    expect(store.posts).toEqual([]);
  });

  test('ticks under two legs make ONE request with two lines, and the button carries the total', async ({ page }) => {
    const store = { detail: detail() };
    const sent = req(1, { totalCents: 2000, lines: [line(1, L2, 'waiting', 'Waiting fee — Kandy → Ella', 1000), line(2, L4, 'waiting', 'Waiting fee — Yala → Mirissa', 1000)] });
    store.onCreate = () => { store.detail = detail({ addOnRequests: [sent] }); return { status: 200, body: { request: sent, emailed: true } }; };
    await boot(page, store);
    await addBtn(page).click();

    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
    await opt(page, 'Kandy → Ella', 'Waiting fee').locator('input').check();
    await expect(sendBtn(page)).toHaveText('Send request · $10');
    await legRow(page, 'Yala → Mirissa').locator('[data-act="addonleg"]').click();
    await opt(page, 'Yala → Mirissa', 'Waiting fee').locator('input').check();

    // Each leg says how many are ticked, open or shut.
    await expect(legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]')).toContainText('1 ticked');
    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
    await expect(opt(page, 'Kandy → Ella', 'Waiting fee')).toBeHidden();
    await expect(legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]')).toContainText('1 ticked');
    await expect(legRow(page, 'Mirissa → Galle').locator('[data-act="addonleg"]')).toContainText('Show add-ons');

    // "In this request": every ticked line, then one total.
    const picked = form(page).locator('[data-testid="addon-picked"] > div');
    await expect(picked).toHaveText(['Waiting fee — Kandy → Ella$10', 'Waiting fee — Yala → Mirissa$10']);
    await expect(form(page).locator('[data-testid="addon-form-total"]')).toHaveText('$20');
    await expect(form(page)).toContainText('Customer pays online, in one payment');
    await expect(sendBtn(page)).toHaveText('Send request · $20');
    await expect(form(page).locator('#addonNotify')).toBeChecked();

    // Send with the keyboard focus still in the form (a tick-box), as an operator would.
    await opt(page, 'Yala → Mirissa', 'Waiting fee').locator('input').focus();
    await sendBtn(page).click();
    await expect(toast(page)).toHaveText('Request sent. Customer emailed the pay link.');
    await expect(toast(page)).not.toHaveClass(/\bbad\b/);
    expect(store.posts).toEqual([{ lines: [{ legId: L2, code: 'waiting' }, { legId: L4, code: 'waiting' }], notifyCustomer: true }]);

    // The form closes and the sheet re-reads: the new request is on the page.
    await expect(form(page)).toHaveCount(0);
    await expect(pill(page, 'A1')).toHaveText('Awaiting payment');
    await expect(card(page, 'A1').locator('[data-testid="addon-total"]')).toHaveText('Total$20');
  });

  test('says so, in the error colour, when the customer was NOT emailed', async ({ page }) => {
    const store = { detail: detail() };
    store.onCreate = () => { store.detail = detail({ addOnRequests: [req(1)] }); return { status: 200, body: { request: req(1), emailed: false } }; };
    await boot(page, store);
    await addBtn(page).click();
    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
    await opt(page, 'Kandy → Ella', 'Sightseeing stops').locator('input').check();
    await form(page).locator('#addonNotify').uncheck();
    await sendBtn(page).click();
    await expect(toast(page)).toHaveText('Saved, but the customer was NOT emailed. WhatsApp them the pay link.');
    await expect(toast(page)).toHaveClass(/\bbad\b/);
    expect(store.posts).toEqual([{ lines: [{ legId: L2, code: 'sightseeing' }], notifyCustomer: false }]);
    // The request exists, so its pay link is there to copy into WhatsApp.
    await expect(card(page, 'A1').locator('[data-act="addoncopy"]')).toHaveCount(1);
  });

  test('an add-on already on a leg is ticked, disabled and says "Already added"', async ({ page }) => {
    const paidWaiting = req(2, { status: 'paid', state: 'paid', payable: false, payLink: null, paymentId: 'pay-a2', lines: [line(2, L2, 'waiting', 'Waiting fee — Kandy → Ella', 1000)] });
    const cancelledFlex = req(3, { status: 'cancelled', state: 'cancelled', payable: false, payLink: null, lines: [line(3, L2, 'flex', 'Flexi ticket — Kandy → Ella', 1200)] });
    const refundedLuggage = req(4, { status: 'paid', state: 'refunded', refundedCents: 500, totalCents: 500, payable: false, payLink: null, paymentId: 'pay-a4', lines: [line(4, L2, 'luggage', 'Luggage rack — Kandy → Ella', 500)] });
    const store = { detail: detail({ addOnRequests: [req(1), paidWaiting, cancelledFlex, refundedLuggage] }) };
    await boot(page, store);
    await addBtn(page).click();
    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();

    for (const label of ['Sightseeing stops', 'Waiting fee']) {
      const o = opt(page, 'Kandy → Ella', label);
      await expect(o.locator('input'), label).toBeChecked();
      await expect(o.locator('input'), label).toBeDisabled();
      await expect(o, label).toContainText('Already added');
    }
    // A cancelled request and a fully refunded one hold nothing: both can be added again.
    for (const label of ['Flexi ticket', 'Luggage rack']) {
      await expect(opt(page, 'Kandy → Ella', label).locator('input'), label).toBeEnabled();
      await expect(opt(page, 'Kandy → Ella', label).locator('input'), label).not.toBeChecked();
    }
    // What is already there is not part of the new request.
    await expect(legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]')).not.toContainText('ticked');
    await expect(sendBtn(page)).toBeDisabled();
    // The same add-on on ANOTHER leg is free.
    await legRow(page, 'Yala → Mirissa').locator('[data-act="addonleg"]').click();
    await expect(opt(page, 'Yala → Mirissa', 'Waiting fee').locator('input')).toBeEnabled();
  });

  test('a one-leg booking opens its leg, and what was bought at booking says "Already booked"', async ({ page }) => {
    await boot(page, { detail: singleDetail() }, { rows: [row({ mode: 'single', route: 'Kandy → Ella', amount: 9000 })] });
    await addBtn(page).click();
    await expect(form(page).locator('[data-testid="addon-leg"]')).toHaveCount(1);
    const waiting = opt(page, 'Kandy → Ella', 'Waiting fee');
    await expect(waiting).toBeVisible();
    await expect(waiting.locator('input')).toBeDisabled();
    await expect(waiting).toContainText('Already booked');
    await expect(opt(page, 'Kandy → Ella', 'Child seat').locator('input')).toBeEnabled();
  });
});

test.describe('a request’s own buttons', () => {
  test('Copy pay link copies THAT request’s payLink', async ({ page, context }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    const other = 'https://ceylonhop.example/manage.html?t=OTHER#add-ons';
    await boot(page, { detail: detail({ addOnRequests: [req(1), req(2, { payLink: other })] }) });
    await card(page, 'A2').locator('[data-act="addoncopy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(other);
    await expect(toast(page)).toHaveText('Pay link copied');
    await card(page, 'A1').locator('[data-act="addoncopy"]').click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe(PAY_LINK);
  });

  test('Cancel request asks for a reason, will not post without one, then posts it', async ({ page }) => {
    const store = { detail: detail({ addOnRequests: [req(1)] }) };
    const gone = req(1, { status: 'cancelled', state: 'cancelled', payable: false, payLink: null, cancelledBy: 'o@x.com', cancelledAt: '2026-11-12T15:00:00.000Z', cancelReason: 'Customer changed their mind' });
    store.onCancel = () => { store.detail = detail({ addOnRequests: [gone] }); return { status: 200, body: { request: gone } }; };
    await boot(page, store);

    await expect(page.locator('#addoncancelreason')).toHaveCount(0);
    await card(page, 'A1').locator('[data-act="addoncancelopen"]').click();
    const reason = page.locator('#addoncancelreason');
    await expect(reason).toBeVisible();
    await expect(card(page, 'A1').locator('.reverse-reason')).toContainText('required');
    await expect(reason).toHaveAttribute('maxlength', '300');

    // No reason: a sentence, the cursor in the box, nothing sent.
    await card(page, 'A1').locator('[data-act="addoncancel"]').click();
    await expect(toast(page)).toHaveText('Give a reason first. It is saved against the request.');
    await expect(reason).toBeFocused();
    expect(store.cancels).toEqual([]);

    // With the cursor still in the reason box, the button still works.
    await reason.fill('  Customer changed their mind ');
    await expect(reason).toBeFocused();
    await card(page, 'A1').locator('[data-act="addoncancel"]').click();
    await expect(toast(page)).toHaveText('Request cancelled');
    expect(store.cancels).toEqual([{ url: '/admin/ops/bookings/b1/add-ons/req-1/cancel', body: { reason: 'Customer changed their mind' } }]);
    await expect(pill(page, 'A1')).toHaveText('Cancelled');
    await expect(card(page, 'A1').locator('.ao-meta')).toContainText('by o@x.com · “Customer changed their mind”');
    await expect(page.locator('#addoncancelreason')).toHaveCount(0);
  });

  test('"Keep request" puts the reason box away without sending anything', async ({ page }) => {
    const store = { detail: detail({ addOnRequests: [req(1)] }) };
    await boot(page, store);
    await card(page, 'A1').locator('[data-act="addoncancelopen"]').click();
    await expect(page.locator('#addoncancelreason')).toBeVisible();
    await card(page, 'A1').locator('[data-act="addoncancelopen"]', { hasText: 'Keep request' }).click();
    await expect(page.locator('#addoncancelreason')).toHaveCount(0);
    expect(store.cancels).toEqual([]);
    await expect(pill(page, 'A1')).toHaveText('Awaiting payment');
  });
});

test.describe('refusals read as sentences', () => {
  test('payment_in_flight on cancel: its sentence, and the card catches up to "Paying now"', async ({ page }) => {
    const store = { detail: detail({ addOnRequests: [req(1)] }) };
    const until = new Date(Date.now() + 25 * 60 * 1000).toISOString();
    store.onCancel = () => { store.detail = detail({ addOnRequests: [req(1, { inFlightUntil: until })] }); return { status: 409, body: { error: 'payment_in_flight' } }; };
    await boot(page, store);
    await card(page, 'A1').locator('[data-act="addoncancelopen"]').click();
    await page.locator('#addoncancelreason').fill('Sent by mistake');
    await card(page, 'A1').locator('[data-act="addoncancel"]').click();
    await expect(toast(page)).toHaveText('The customer is on the payment page right now. Wait until the time shown on the request, then cancel it if they have not paid.');
    await expect(toast(page)).toHaveClass(/\bbad\b/);
    await expect(toast(page)).not.toContainText('payment_in_flight');
    await expect(pill(page, 'A1')).toHaveText('Paying now');
    await expect(card(page, 'A1')).toContainText(`Can be cancelled after ${await hhmm(page, until)} if they don’t pay.`);
  });

  test('duplicate_add_on on send: its sentence, and the form stays open with the ticks kept', async ({ page }) => {
    const store = { detail: detail() };
    store.onCreate = () => ({ status: 409, body: { error: 'duplicate_add_on' } });
    await boot(page, store);
    await addBtn(page).click();
    await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
    await opt(page, 'Kandy → Ella', 'Child seat').locator('input').check();
    await sendBtn(page).click();
    await expect(toast(page)).toHaveText('That add-on is already on that leg. Each add-on can be added once per leg.');
    await expect(toast(page)).toHaveClass(/\bbad\b/);
    await expect(form(page)).toHaveCount(1);
    await expect(opt(page, 'Kandy → Ella', 'Child seat').locator('input')).toBeChecked();
    await expect(sendBtn(page)).toHaveText('Send request · $8');
  });

  test('every code the two routes can send has a sentence of its own', async ({ page }) => {
    await boot(page, { detail: detail() });
    const CODES = ['bad_request', 'unknown_add_on', 'forbidden', 'not_found', 'leg_not_found', 'not_private', 'booking_not_eligible',
      'awaiting_price', 'legs_missing', 'leg_not_driven', 'leg_passed', 'duplicate_add_on', 'already_bought_at_booking',
      'request_not_found', 'already_paid', 'not_open', 'payment_in_flight'];
    const map = await page.evaluate(() => ADDON_ERR);
    expect(Object.keys(map).sort()).toEqual([...CODES].sort());
    const seen = new Set();
    for (const code of CODES) {
      const s = map[code];
      expect(s, code).toMatch(/^[A-Z].{20,}\.$/);      // a whole sentence
      expect(s, code).not.toMatch(/[_—]|\bAPI\b|\b\d{3}\b/); // no code, no em dash, no status number
      expect(seen.has(s), code).toBe(false);
      seen.add(s);
    }
  });
});

test.describe('elsewhere in the pane', () => {
  const paid = { status: 'paid', state: 'paid', payable: false, payLink: null, paidAt: '2026-11-12T14:05:00.000Z' };
  const addOnPay = (id, orderId, over = {}) => ({ id, bookingId: 'b1', provider: 'payhere', orderId, amount: 1000, currency: 'USD', status: 'succeeded', purpose: 'add_on', ...over });

  test('the Payment fold names each add-on payment by its request, and never guesses one', async ({ page }) => {
    const until = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const store = { detail: detail({
      // A1 has no payment yet. The stray add-on payment below is for the same $10: it must not be called A1.
      addOnRequests: [req(1), req(2, { inFlightUntil: until, paymentId: 'pay-a2' }), req(3, { ...paid, paymentId: 'pay-a3' })],
      payments: [TRIP_PAYMENT, addOnPay('pay-a2', 'CH-V72WB-A2', { status: 'pending' }), addOnPay('pay-a3', 'CH-V72WB-A3'), addOnPay('pay-stray', 'CH-V72WB-A9', { status: 'failed' })],
    }) };
    await boot(page, store, { caps: FOUNDER });
    await fold(page, 'payment').locator('> summary').click();
    const rows = fold(page, 'payment').locator('[data-testid="pay-addon"]');
    await expect(rows).toHaveCount(3);
    await expect(rows.nth(0).locator('.k')).toHaveText('Add-on A2');
    await expect(rows.nth(0).locator('.v')).toHaveText('$10 · not paid yet');
    await expect(rows.nth(1).locator('.k')).toHaveText('Add-on A3');
    await expect(rows.nth(1).locator('.v')).toHaveText('$10 · paid');
    await expect(rows.nth(2).locator('.k')).toHaveText('Add-on');
    await expect(rows.nth(2).locator('.v')).toHaveText('$10 · payment failed');
    // The trip's own figure is still the trip's.
    await expect(fold(page, 'payment').getByText('Amount', { exact: true }).locator('..').locator('.v')).toHaveText('$236');
  });

  test('the refund panel names the add-on payment as its target', async ({ page }) => {
    const store = { detail: detail({ addOnRequests: [req(3, { ...paid, paymentId: 'pay-a3' })], payments: [TRIP_PAYMENT, addOnPay('pay-a3', 'CH-V72WB-A3')] }) };
    await boot(page, store, { caps: FOUNDER });
    await fold(page, 'refund').locator('> summary').click();
    const targets = fold(page, 'refund').locator('[data-act="refundrequest"]');
    await expect(targets).toHaveCount(2);
    await expect(fold(page, 'refund').locator('[data-act="refundrequest"][data-payment-id="pay-trip"]')).toHaveText('Refund: card payment — $236 remaining');
    await expect(fold(page, 'refund').locator('[data-act="refundrequest"][data-payment-id="pay-a3"]')).toHaveText('Refund: Add-on A3 — $10 remaining');
  });

  test('an add-on that is the only money taken is still named, and the trip’s line picker is not offered for it', async ({ page }) => {
    // Pay on the day: the trip's cash is not in yet, the add-on was paid online.
    const refundLines = { currency: 'USD', lines: [{ kind: 'leg', index: 0, label: 'Kandy → Ella (car)', amountCents: 11800 }, { kind: 'leg', index: 1, label: 'Yala → Mirissa (car)', amountCents: 11800 }] };
    const store = { detail: detail({ addOnRequests: [req(3, { ...paid, paymentId: 'pay-a3' })], payments: [addOnPay('pay-a3', 'CH-V72WB-A3')], refundLines }) };
    await boot(page, store, { caps: OPS });
    await fold(page, 'refund').locator('> summary').click();
    const btn = fold(page, 'refund').locator('[data-act="refundrequest"]');
    await expect(btn).toHaveCount(1);
    await expect(btn).toHaveText('Request refund: Add-on A3 — $10 remaining');
    await expect(btn).toHaveAttribute('data-payment-id', 'pay-a3');
    await expect(fold(page, 'refund').locator('.refund-lines')).toHaveCount(0);
  });

  test('History gains request sent, paid and cancelled, each with who and how much', async ({ page }) => {
    const store = { detail: detail({ addOnRequests: [
      req(1),
      req(3, { ...paid, paymentId: 'pay-a3' }),
      req(5, { status: 'cancelled', state: 'cancelled', payable: false, payLink: null, cancelledBy: 'lead@x.com', cancelledAt: '2026-11-12T15:00:00.000Z', cancelReason: 'Customer changed their mind' }),
    ] }) };
    await boot(page, store);
    await fold(page, 'history').locator('> summary').click();
    const acts = fold(page, 'history').locator('.act');
    const entry = (text) => acts.filter({ hasText: text });
    await expect(entry('Add-on request A1 sent ($10) by o@x.com')).toHaveCount(1);
    await expect(entry('Add-on request A1 sent ($10) by o@x.com').locator('.at')).toHaveText(await fmtDateTime(page, '2026-11-12T13:08:46.313Z'));
    await expect(entry('Add-on request A3 paid ($10)')).toHaveCount(1);
    await expect(entry('Add-on request A3 paid ($10)').locator('.at')).toHaveText(await fmtDateTime(page, '2026-11-12T14:05:00.000Z'));
    await expect(entry('Add-on request A5 cancelled by lead@x.com · Customer changed their mind')).toHaveCount(1);
    // A1 was never paid or cancelled, so it has one entry only.
    await expect(entry('Add-on request A1')).toHaveCount(1);
  });

  test.describe('after the trip is refunded in full', () => {
    const tripRefund = (amountCents, status = 'api_confirmed') => ({
      id: 'refund-1', bookingId: 'b1', paymentId: 'pay-trip', provider: 'payhere', amountCents, currency: 'USD', status,
      reason: 'Trip called off', gatewayRef: 'PH-1', requestedBy: 'f@x.com', requestedAt: '2026-11-12T16:00:00.000Z',
      confirmedBy: 'f@x.com', confirmedAt: '2026-11-12T16:01:00.000Z', createdAt: '2026-11-12T16:00:00.000Z', updatedAt: '2026-11-12T16:01:00.000Z',
    });
    const cancelled = (requests) => { const d = detail({ addOnRequests: requests, addOnCatalogue: undefined, payments: [TRIP_PAYMENT, addOnPay('pay-a3', 'CH-V72WB-A3')] }); d.booking.status = 'cancelled'; return d; };
    const closedRow = { rows: [row({ stage: 'cancelled' })], stage: 'closed', caps: FOUNDER };
    const note = (page) => page.locator('#sheet [data-testid="addon-refund-due"]');

    test('a paid add-on that was not refunded is called out, and the Refund fold opens on it', async ({ page }) => {
      const store = { detail: cancelled([req(3, { ...paid, paymentId: 'pay-a3' })]), refunds: [tripRefund(23600)] };
      await boot(page, store, closedRow);
      await expect(fold(page, 'refund')).toHaveAttribute('open', '');
      await expect(fold(page, 'refund').locator('> summary .fold-sum')).toContainText('add-on payment still needs refunding');
      await expect(note(page)).toBeVisible();
      await expect(note(page)).toHaveText('The trip has been refunded in full, but add-on A3 ($10) has not. Refund the add-on payment too.');
    });

    test('nothing is said once the add-on is refunded too', async ({ page }) => {
      const store = { detail: cancelled([req(3, { ...paid, state: 'refunded', refundedCents: 1000, paymentId: 'pay-a3' })]), refunds: [tripRefund(23600)] };
      await boot(page, store, closedRow);
      await expect(pill(page, 'A3')).toHaveText('Refunded');
      await expect(note(page)).toHaveCount(0);
    });

    test('nothing is said while the trip itself is only part refunded', async ({ page }) => {
      const store = { detail: cancelled([req(3, { ...paid, paymentId: 'pay-a3' })]), refunds: [tripRefund(5000)] };
      await boot(page, store, closedRow);
      await expect(pill(page, 'A3')).toHaveText('Paid');
      await expect(note(page)).toHaveCount(0);
    });
  });
});

test('a slow answer for one booking never paints over the booking opened after it', async ({ page }) => {
  // The send for b1 is still in flight when the operator opens b2. When it lands, the toast may
  // still speak, but b2's sheet must keep showing b2: no A1 card, no b1 customer.
  const store = { detail: detail() };
  let release;
  const held = new Promise((r) => { release = r; });
  store.onCreate = async () => {
    await held;
    store.detail = detail({ addOnRequests: [req(1)] });
    return { status: 200, body: { request: req(1), emailed: true } };
  };
  const b2 = singleDetail();
  b2.booking.id = 'b2'; b2.booking.reference = 'CH-OTHER'; b2.booking.addOns = [];
  b2.booking.input.customer = { ...CUSTOMER, firstName: 'Bram', lastName: 'Other' };
  b2.addOnCatalogue = undefined;
  await boot(page, store, { rows: [row(), row({ id: 'b2', reference: 'CH-OTHER', customerName: 'Bram Other', customerFirstName: 'Bram', mode: 'single', route: 'Kandy → Ella' })] });
  // Registered after boot: the newest route wins, and boot's catch-all would otherwise answer {}.
  await page.route('**/admin/ops/bookings/b2', (r) => r.fulfill(json(b2)));

  await addBtn(page).click();
  await legRow(page, 'Kandy → Ella').locator('[data-act="addonleg"]').click();
  await opt(page, 'Kandy → Ella', 'Sightseeing stops').locator('input').check();
  await sendBtn(page).click();
  await expect.poll(() => store.posts.length).toBe(1);

  // The scrim covers the list while a sheet is open, so open b2 the way a deep link would.
  await page.locator('.tk[data-act="open"][data-id="b2"]').dispatchEvent('click');
  await expect(page.locator('#sheet .sheet-h h2')).toHaveText('Bram Other');
  await page.waitForSelector('#sheet.show .sheet-b:not(.skel)', { timeout: 10000 });
  const readsBefore = store.reads;
  release();
  await expect(toast(page)).toHaveText('Request sent. Customer emailed the pay link.');
  await expect.poll(() => store.reads).toBeGreaterThan(readsBefore); // b1 was re-read…
  await page.waitForTimeout(150);
  // …and b2 is still what is on screen.
  await expect(page.locator('#sheet .sheet-h h2')).toHaveText('Bram Other');
  await expect(page.locator('#sheet [data-testid="addon-request"]')).toHaveCount(0);
  await expect(page.locator('#sheet')).not.toContainText('Request A1');
});

test.describe('layout', () => {
  // Nothing in the section may poke out of it sideways, and the sheet body must not scroll sideways.
  const measure = (page) => page.evaluate(() => {
    const sheet = document.querySelector('#sheet'), sb = sheet.querySelector('.sheet-b');
    const sec = sheet.querySelector('[data-testid="sheet-addons"]');
    const box = sec.getBoundingClientRect();
    const name = (el) => el.tagName.toLowerCase() + (el.className ? '.' + String(el.className).replace(/\s+/g, '.') : '');
    const out = [...sec.querySelectorAll('*')].filter((el) => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && (r.right > box.right + 0.5 || r.left < box.left - 0.5);
    }).map(name);
    const clipped = [...sec.querySelectorAll('button, .pill, .ao-tag')].filter((el) => el.offsetWidth > 0 && el.scrollWidth > el.clientWidth + 1).map(name);
    return { sheetW: Math.round(sheet.getBoundingClientRect().width), sideScroll: sb.scrollWidth - sb.clientWidth, out, clipped, secW: Math.round(box.width) };
  });
  const LONG = 'operations.team.colombo@ceylonhop.example';
  const busy = () => {
    const until = new Date(Date.now() + 20 * 60 * 1000).toISOString();
    const d = detail({ addOnRequests: [
      req(1, { createdBy: LONG, totalCents: 2900, lines: [SIGHT_L2, line(2, L4, 'safari-wait', 'Wait for Safari — Yala → Mirissa', 1900)] }),
      req(2, { createdBy: LONG, inFlightUntil: until, paymentId: 'pay-a2' }),
      req(3, { status: 'paid', state: 'paid', payable: false, payLink: null, paidAt: '2026-11-12T14:05:00.000Z', paymentId: 'pay-a3' }),
      req(5, { status: 'cancelled', state: 'cancelled', payable: false, payLink: null, cancelledBy: LONG, cancelledAt: '2026-11-12T15:00:00.000Z', cancelReason: 'The customer changed their mind after talking to the hotel about the tea factory visit' }),
      req(6, { state: 'cancelled_with_booking', payable: false, payLink: null }),
    ] });
    d.booking.addOns = ['Waiting fee — Negombo → Kandy', 'Sightseeing stops (up to 3h) — Bandaranaike International Airport → Kandy'];
    return d;
  };
  const openFormWithTicks = async (page) => {
    await addBtn(page).click();
    await legRow(page, 'Yala → Mirissa').locator('[data-act="addonleg"]').click();
    await opt(page, 'Yala → Mirissa', 'Waiting fee').locator('input').check();
    await legRow(page, 'Mirissa → Galle').locator('[data-act="addonleg"]').click();
    await opt(page, 'Mirissa → Galle', 'Waiting fee').locator('input').check();
    await card(page, 'A1').locator('[data-act="addoncancelopen"]').click();
    await expect(sendBtn(page)).toHaveText('Send request · $20');
  };

  test('nothing overflows at the 780 px pane, with every kind of card, the form and a cancel box open', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await boot(page, { detail: busy() });
    await openFormWithTicks(page);
    const m = await measure(page);
    expect(m.sheetW).toBe(780);
    expect(m.sideScroll).toBeLessThanOrEqual(0);
    expect(m.out).toEqual([]);
    expect(m.clipped).toEqual([]);
  });

  test('nor in the one-column pane a smaller screen gets', async ({ page }) => {
    await page.setViewportSize({ width: 880, height: 900 });
    await boot(page, { detail: busy() });
    await openFormWithTicks(page);
    const m = await measure(page);
    expect(m.sheetW).toBe(500);
    expect(m.sideScroll).toBeLessThanOrEqual(0);
    expect(m.out).toEqual([]);
    expect(m.clipped).toEqual([]);
  });

  test('nor on a phone', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await boot(page, { detail: busy() });
    await openFormWithTicks(page);
    const m = await measure(page);
    expect(m.sideScroll).toBeLessThanOrEqual(0);
    expect(m.out).toEqual([]);
    expect(m.clipped).toEqual([]);
  });
});
