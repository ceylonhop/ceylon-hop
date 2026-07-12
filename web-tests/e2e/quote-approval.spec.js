import { test, expect } from '@playwright/test';

// Maker-checker quote workflow, driven offline against the raw ops SPA
// (api/src/routes/ops-ui.html) with every /admin/** call stubbed — no DB, no API.
// The whoami `caps` array is the role seam: a founder holds quote:approve (+ margin:view),
// a support agent (ops/finance) does not. These specs assert the three journeys the merge
// is built around:
//   1. Support submits a quote → it lands in the queue; support cannot approve or copy.
//   2. Founder reviews from the queue → approves (or sends back); can self-approve a draft.
//   3. Support opens an approved (ready) quote → the customer message + Copy unlock.
//
// Same offline harness as ops-vehicle-chips.spec.js: serve the file, stub /admin/**,
// deep-link where useful, and drive the real client code.

const OPS_FILE = '/api/src/routes/ops-ui.html';

const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

// A saved-quote summary row as GET /admin/quote/list returns them.
function summary(over) {
  return {
    id: over.id,
    reference: over.reference || 'Q-' + over.id.toUpperCase(),
    customerName: over.customerName || 'Traveller ' + over.id,
    product: over.product || 'private',
    vehicle: over.vehicle || 'car',
    totalCents: over.totalCents || 12100,
    currency: 'USD',
    status: over.status,
  };
}

// A full saved quote as GET /admin/quote/:id returns it (incl. the request.tool snapshot
// the builder needs to reopen). Margin fields are only present for founder in real life;
// the client never depends on them being present.
function fullQuote(over) {
  return {
    id: over.id,
    reference: over.reference || 'Q-' + over.id.toUpperCase(),
    channel: 'ops',
    status: over.status,
    product: over.product || 'private',
    vehicle: over.vehicle || 'car',
    customerName: over.customerName || 'Traveller ' + over.id,
    customerContact: over.customerContact || '+44 7700 900000',
    totalCents: over.totalCents || 12100,
    currency: 'USD',
    notes: over.notes || null,
    createdAt: '2026-07-08T09:00:00.000Z',
    updatedAt: '2026-07-08T10:00:00.000Z',
    request: {
      tool: {
        name: over.customerName || 'Traveller ' + over.id,
        contact: over.customerContact || '+44 7700 900000',
        vehicle: over.vehicle || 'car',
        service: 'private',
        passengerCount: 2,
        luggageCount: 2,
        legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120 }],
      },
    },
    result: { totalCents: over.totalCents || 12100 },
  };
}

const RATE_CARD = {
  rateCardVersion: '2026-07-09',
  perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
  vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 }, van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 } },
  chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
};

const ESTIMATE = {
  product: 'private',
  total: { cents: 12100, lkr: 'LKR 39,930' },
  lineItems: [{ label: 'Colombo → Kandy (car)', amountCents: 12100, lkr: 'LKR 39,930' }],
  breakdown: { km: { distanceKm: 120, bufferKm: 12, billableKm: 132 }, legs: [{ cents: 12100 }] },
  services: { pointToPoint: { total: { cents: 12100, lkr: 'LKR 39,930' } }, chauffeur: { error: 'single-day trip — point-to-point only' } },
  warnings: [],
};

// Wire the common stubs. `role` picks the caps; `quotes` is the list the queue shows;
// `store` lets a test capture PATCH/POST bodies. Returns the store for assertions.
async function harness(page, { role = 'founder', quotes = [] } = {}) {
  const CAPS = {
    founder: ['quote:manage', 'quote:approve', 'margin:view', 'bookings:read', 'bookings:operate', 'payments:act'],
    finance: ['quote:manage', 'bookings:read', 'payments:act'],
    ops: ['quote:manage', 'bookings:operate', 'bookings:read'],
  };
  const store = { patches: [], saves: [], list: quotes.slice() };

  await page.addInitScript(() => {
    window.google = { accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } }, maps: { importLibrary: async () => ({}) } };
  });

  // Playwright matches routes in REVERSE registration order (last-registered wins), so
  // register the broad catch-all FIRST and the more specific handlers AFTER it.
  await page.route('**/admin/**', (r) => r.fulfill(json({})));

  // POST /admin/quote/save → mint an id; GET/PATCH /admin/quote/:id.
  await page.route('**/admin/quote/**', async (r) => {
    const req = r.request();
    const url = req.url();
    const method = req.method();
    if (url.endsWith('/save') && method === 'POST') {
      const body = JSON.parse(req.postData() || '{}');
      store.saves.push(body);
      // Mirror the real API's upsert: a body carrying an existing id updates in place
      // (same id/reference/status); otherwise insert a fresh draft.
      if (body.id) {
        const existing = store.list.find((q) => q.id === body.id);
        if (existing) {
          // Mirror the real API's maker-checker lock: a content re-save is only allowed while the
          // quote is still editable; a ready/sent/decided quote 409s (internalQuote /save guard).
          if (!['draft', 'pending_review', 'changes_requested'].includes(existing.status)) {
            return r.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'not_editable', status: existing.status }) });
          }
          if (body.name) existing.customerName = body.name;
          return r.fulfill(json(fullQuote({ id: body.id, status: existing.status, customerName: existing.customerName })));
        }
      }
      const saved = fullQuote({ id: 'new1', status: 'draft', customerName: body.name });
      store.list.unshift(summary({ id: 'new1', status: 'draft', customerName: body.name }));
      return r.fulfill(json(saved));
    }
    const m = url.match(/\/admin\/quote\/([^/?]+)$/);
    if (m && method === 'PATCH') {
      const id = m[1];
      const body = JSON.parse(req.postData() || '{}');
      store.patches.push({ id, ...body });
      const existing = store.list.find((q) => q.id === id);
      if (existing && body.status) existing.status = body.status;
      return r.fulfill(json(fullQuote({ id, status: body.status || 'draft' })));
    }
    if (m && method === 'GET') {
      const id = m[1];
      const existing = store.list.find((q) => q.id === id) || {};
      return r.fulfill(json(fullQuote({ id, status: existing.status || 'draft', customerName: existing.customerName })));
    }
    return r.fulfill(json({}));
  });

  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: store.list })));
  // The real server includes `margin` only for margin:view (founder) — mirror that so the
  // client-side founder-only gating can be asserted.
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json(
    role === 'founder' ? { ...ESTIMATE, margin: { cents: 6200, lkr: 'LKR 20,460' } } : ESTIMATE,
  )));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: role + '@e2e.test', role, caps: CAPS[role] })));
  return store;
}

// Land in the merged Quotes queue (post-login) as the given role.
async function openQueue(page, role, quotes) {
  const store = await harness(page, { role, quotes });
  await page.goto(OPS_FILE + '#quotes');
  await page.waitForSelector('#view .qhead', { timeout: 10000 });
  return store;
}

// Open a single quote of a known status in the builder (detail view) by clicking its
// queue row — the real path a user takes. Returns the harness store for PATCH assertions.
async function openDetail(page, role, over) {
  const q = summary(over);
  const store = await harness(page, { role, quotes: [q] });
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view .qrow').first().click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.waitForSelector('.ch-status-pill', { timeout: 10000 });
  // Let the async /estimate resolve so its re-render is done before the test interacts —
  // otherwise a late re-render can detach an element mid-click under parallel load.
  await page.waitForLoadState('networkidle');
  return store;
}
const actions = (page) => page.locator('.ch-actionbar');

// ── Task 5: merged nav — Bookings · Quotes, no "Generate Quote" ──────────────────
test('nav is Bookings · Quotes only — the separate "Generate Quote" tab is gone', async ({ page }) => {
  await openQueue(page, 'founder', []);
  await expect(page.locator('#nav button[data-route="tickets"]')).toBeVisible();
  await expect(page.locator('#nav button[data-route="quotes"]')).toBeVisible();
  await expect(page.locator('#nav button[data-route="quote"]')).toHaveCount(0);
});

test('the Quotes queue carries a "+ New quote" button that opens the builder', async ({ page }) => {
  await openQueue(page, 'ops', []);
  await expect(page.locator('#view [data-qnew]')).toBeVisible();
  await page.locator('#view [data-qnew]').click();
  await expect(page.locator('#quoteRoot .ch-app')).toBeVisible({ timeout: 10000 });
});

// ── Task 6: role-aware queue sections ────────────────────────────────────────────
test('founder queue leads with "Needs your review" (pending_review first)', async ({ page }) => {
  await openQueue(page, 'founder', [
    summary({ id: 'a', status: 'ready' }),
    summary({ id: 'b', status: 'pending_review' }),
    summary({ id: 'c', status: 'draft' }),
  ]);
  const sections = page.locator('#view .qsection-title');
  await expect(sections.first()).toContainText(/needs your review/i);
  // The pending_review quote sits in that first section.
  await expect(page.locator('#view .qsection').first().locator('.qrow')).toHaveCount(1);
});

test('support queue leads with "Ready to send" and surfaces "Sent back to you"', async ({ page }) => {
  await openQueue(page, 'ops', [
    summary({ id: 'a', status: 'draft' }),
    summary({ id: 'b', status: 'ready' }),
    summary({ id: 'c', status: 'changes_requested' }),
  ]);
  const titles = page.locator('#view .qsection-title');
  await expect(titles.first()).toContainText(/ready to send/i);
  await expect(page.locator('#view')).toContainText(/sent back to you/i);
});

test('support never sees a margin figure in the queue', async ({ page }) => {
  await openQueue(page, 'ops', [summary({ id: 'a', status: 'ready' })]);
  await expect(page.locator('#view')).not.toContainText(/margin/i);
});

test('queue filter toggles narrow the list by status group', async ({ page }) => {
  await openQueue(page, 'founder', [
    summary({ id: 'a', status: 'ready' }),
    summary({ id: 'b', status: 'draft' }),
    summary({ id: 'c', status: 'sent' }),
    summary({ id: 'd', status: 'pending_review' }),
  ]);
  await expect(page.locator('#view .qrow')).toHaveCount(4); // All (default)
  await page.locator('[data-qfilter="ready"]').click();
  await expect(page.locator('[data-qfilter="ready"]')).toHaveClass(/on/);
  await expect(page.locator('#view .qrow')).toHaveCount(1); // only ready
  await page.locator('[data-qfilter="progress"]').click();
  await expect(page.locator('#view .qrow')).toHaveCount(2); // draft + pending_review
  await page.locator('[data-qfilter="sent"]').click();
  await expect(page.locator('#view .qrow')).toHaveCount(1); // sent
  await page.locator('[data-qfilter="all"]').click();
  await expect(page.locator('#view .qrow')).toHaveCount(4);
});

// ── Task 7: detail-view action bar (role + status) ───────────────────────────────
test('support on a draft can Submit for review but has no Approve action', async ({ page }) => {
  await openDetail(page, 'ops', { id: 'q1', status: 'draft' });
  await expect(page.locator('.ch-status-pill')).toContainText('Draft');
  await expect(actions(page).locator('[data-action="submitForReview"]')).toBeVisible();
  await expect(actions(page).locator('[data-action="approveReady"]')).toHaveCount(0);
  await expect(actions(page).locator('[data-action="sendBack"]')).toHaveCount(0);
});

test('founder on a pending_review quote gets Approve + Send back', async ({ page }) => {
  await openDetail(page, 'founder', { id: 'q1', status: 'pending_review' });
  await expect(page.locator('.ch-status-pill')).toContainText('In review');
  await expect(actions(page).locator('[data-action="approveReady"]')).toBeVisible();
  await expect(actions(page).locator('[data-action="sendBack"]')).toBeVisible();
  await expect(page.locator('.ch-review-banner')).toContainText(/pricing and margin/i);
});

test('founder can self-approve a draft in one hop (Approve — ready to send)', async ({ page }) => {
  await openDetail(page, 'founder', { id: 'q1', status: 'draft' });
  await expect(actions(page).locator('[data-action="approveReady"]')).toBeVisible();
});

test('clicking Approve PATCHes the quote to ready and returns to the queue', async ({ page }) => {
  const store = await openDetail(page, 'founder', { id: 'q1', status: 'pending_review' });
  await actions(page).locator('[data-action="approveReady"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 }); // bounced back to queue
  expect(store.patches.some((p) => p.id === 'q1' && p.status === 'ready')).toBe(true);
});

test('clicking Submit for review PATCHes the quote to pending_review', async ({ page }) => {
  const store = await openDetail(page, 'ops', { id: 'q1', status: 'draft' });
  await actions(page).locator('[data-action="submitForReview"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 });
  expect(store.patches.some((p) => p.id === 'q1' && p.status === 'pending_review')).toBe(true);
});

// Regression: transition() used to save-first unconditionally, but the /save maker-checker lock
// (commit 3d93b56) 409s a content re-save on a ready/sent quote — which silently aborted the
// transition. Mark-as-sent and Reopen-to-edit start FROM ready, so both broke. The fix skips the
// save-first when the quote is already content-locked (nothing editable to flush).
test('Mark as sent on a ready quote PATCHes to sent (no spurious /save 409 abort)', async ({ page }) => {
  const store = await openDetail(page, 'founder', { id: 'q1', status: 'ready' });
  await actions(page).locator('[data-action="markSent"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 }); // bounced back to queue
  expect(store.patches.some((p) => p.id === 'q1' && p.status === 'sent')).toBe(true);
});

test('Reopen to edit on a ready quote PATCHes to draft (no spurious /save 409 abort)', async ({ page }) => {
  const store = await openDetail(page, 'founder', { id: 'q1', status: 'ready' });
  await actions(page).locator('[data-action="reopenToDraft"]').click();
  await expect(page.locator('.ch-status-pill')).toContainText('Draft', { timeout: 10000 });
  expect(store.patches.some((p) => p.id === 'q1' && p.status === 'draft')).toBe(true);
});

test('Send back opens an inline note composer and captures the note on the PATCH', async ({ page }) => {
  const store = await openDetail(page, 'founder', { id: 'q1', status: 'pending_review' });
  await actions(page).locator('[data-action="sendBack"]').click();
  await expect(page.locator('#sendBackNote')).toBeVisible(); // inline composer, not a native prompt
  await page.fill('#sendBackNote', 'Add the airport pickup leg');
  await page.locator('[data-action="confirmSendBack"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible({ timeout: 10000 });
  const sb = store.patches.find((p) => p.id === 'q1' && p.status === 'changes_requested');
  expect(sb).toBeTruthy();
  expect(sb.notes).toBe('Add the airport pickup leg');
});

test('Send back with an empty note is blocked (no PATCH)', async ({ page }) => {
  const store = await openDetail(page, 'founder', { id: 'q1', status: 'pending_review' });
  await actions(page).locator('[data-action="sendBack"]').click();
  await page.locator('[data-action="confirmSendBack"]').click(); // empty note
  await expect(page.locator('#sendBackNote')).toBeVisible(); // stays open
  expect(store.patches.some((p) => p.status === 'changes_requested')).toBe(false);
});

// ── Task 8: copy gate ────────────────────────────────────────────────────────────
test('support cannot copy a draft — Copy is locked and the message is hidden', async ({ page }) => {
  await openDetail(page, 'ops', { id: 'q1', status: 'draft' });
  await page.locator('.ch-tab[data-tab="whatsapp"]').click();
  await expect(page.locator('.ch-copy-btn')).toBeDisabled();
  await expect(page.locator('.ch-copy-lock')).toBeVisible();
  await expect(page.locator('.ch-copy-lock')).toContainText(/unlocks/i);
  // Internal is never gated.
  await page.locator('.ch-tab[data-tab="internal"]').click();
  await expect(page.locator('.ch-copy-lock')).toHaveCount(0);
});

test('once approved (ready), support can copy the customer message', async ({ page }) => {
  await openDetail(page, 'ops', { id: 'q1', status: 'ready' });
  await page.locator('.ch-tab[data-tab="whatsapp"]').click();
  await expect(page.locator('.ch-copy-btn')).toBeEnabled();
  await expect(page.locator('.ch-copy-lock')).toHaveCount(0);
  await expect(page.locator('.ch-pre')).toBeVisible(); // the message is shown
});

test('the customer message stays hidden until approved — even for the founder', async ({ page }) => {
  await openDetail(page, 'founder', { id: 'q1', status: 'pending_review' });
  await page.locator('.ch-tab[data-tab="whatsapp"]').click();
  await expect(page.locator('.ch-copy-lock')).toBeVisible();      // hidden behind the lock…
  await expect(page.locator('.ch-pre')).toHaveCount(0);           // …the wording is not rendered
  await expect(page.locator('.ch-copy-btn')).toBeDisabled();      // and can't send yet
  // Internal is never gated — the founder reviews pricing there before approving.
  await page.locator('.ch-tab[data-tab="internal"]').click();
  await expect(page.locator('.ch-copy-lock')).toHaveCount(0);
});

// ── Side-nav collapse toggle ─────────────────────────────────────────────────────
test('the rail collapses to an icon strip and the choice persists', async ({ page }) => {
  await openQueue(page, 'founder', []);
  await expect(page.locator('#approot')).not.toHaveClass(/rail-collapsed/);
  await page.locator('#railToggle').click();
  await expect(page.locator('#approot')).toHaveClass(/rail-collapsed/);
  // Persisted, so a fresh load of the same surface stays collapsed.
  await page.goto(OPS_FILE + '#quotes');
  await page.waitForSelector('#view .qhead');
  await expect(page.locator('#approot')).toHaveClass(/rail-collapsed/);
  // Toggling back expands it.
  await page.locator('#railToggle').click();
  await expect(page.locator('#approot')).not.toHaveClass(/rail-collapsed/);
});

// ── Margin + Rates are founder-only across the detail view ───────────────────────
test('founder sees the estimated margin and the Rates button', async ({ page }) => {
  await openDetail(page, 'founder', { id: 'q1', status: 'draft' });
  await expect(page.locator('.ch-margin')).toContainText(/Est\. margin/i);
  await expect(page.locator('#btnRates')).toBeVisible();
});

for (const role of ['ops', 'finance']) {
  test(`${role} never sees margin/profit or the Rates button in the builder`, async ({ page }) => {
    await openDetail(page, role, { id: 'q1', status: 'draft' });
    // No margin anywhere in the builder (money pane or internal tab).
    await expect(page.locator('.ch-margin')).toHaveCount(0);
    await page.locator('.ch-tab[data-tab="internal"]').click();
    await expect(page.locator('#quoteRoot .ch-app')).not.toContainText(/margin/i);
    // Rates (rate-card) button is founder-only.
    await expect(page.locator('#btnRates')).toHaveCount(0);
    // And even a forced openRates action can't reveal the modal.
    await page.evaluate(() => {
      const el = document.querySelector('[data-action="openRates"]') || document.createElement('button');
      el.setAttribute('data-action', 'openRates');
      document.querySelector('#quoteRoot .ch-app').appendChild(el);
      el.click();
    });
    await expect(page.locator('.ch-modal')).toHaveCount(0);
  });
}

// A JS-error tripwire: drive the main flows and fail on any uncaught page error.
test('no console errors while opening the detail view and switching output tabs', async ({ page }) => {
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await openDetail(page, 'founder', { id: 'q1', status: 'ready' });
  for (const t of ['internal', 'whatsapp', 'email']) await page.locator(`.ch-tab[data-tab="${t}"]`).click();
  await page.locator('[data-action="backToQueue"]').click();
  await expect(page.locator('#view .qhead')).toBeVisible();
  expect(errors).toEqual([]);
});
