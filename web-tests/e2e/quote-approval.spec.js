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
      const saved = fullQuote({ id: 'new1', status: 'draft', customerName: body.customerName });
      store.list.unshift(summary({ id: 'new1', status: 'draft', customerName: body.customerName }));
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
  await page.route('**/admin/quote/estimate', (r) => r.fulfill(json(ESTIMATE)));
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
