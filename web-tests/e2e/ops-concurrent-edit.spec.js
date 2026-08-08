import { test, expect } from '@playwright/test';

// Concurrent-edit notice (owner, 2026-08-01): two people can open the same quote and quietly
// overwrite each other. Not a hard lock — a lock with no heartbeat outlives a closed laptop and
// a stuck lock is worse than the clash. This says who was last in here, and when.
//
// Originally:
// (docs/known-bugs.md, 2026-07-30). reopenQuote() nulls lastEstimate and schedules a re-price
// behind the 350ms debounce; until it landed, submitBlockers() could not tell "not priced YET"
// from "could not be costed", so approveReady() opened the blockers panel and returned. ~100ms
// later the estimate arrived and the panel self-healed — so the press was silently swallowed and
// the operator had to press again with no idea why.
//
// This lives OFFLINE on purpose. The same regression is covered by quote-tool.spec.js, but that
// spec is CH_E2E_API-gated and CI runs no Playwright at all, so it would gate nothing.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });

const TOOL = {
  firstName: 'Maya', lastName: 'Silva', contact: '+94770000000',
  vehicle: 'car', service: 'private', requestedService: 'private',
  passengerCount: 2, luggageCount: 2,
  legs: [{ category: 'transfer', from: 'Colombo', to: 'Kandy', distanceKm: 120, date: '',
    addSightseeingFee: false, addWaitingFee: false, addSafariWait: false,
    stops: ['Colombo', 'Kandy'], segmentKms: [120] }],
};

async function stub(page, rec) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {},
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/quote/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'f@e2e.test', role: 'founder', caps: ['quote:manage', 'margin:view', 'quote:approve'] })));
  await page.route('**/admin/ops/bookings**', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09', perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
    vehicle: { car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 9 }, van14: { maxPax: 14, maxBags: 14 }, custom: { maxPax: 99, maxBags: 99 } },
  })));

  // The estimate is deliberately SLOW — this is the window the bug lived in.
  await page.route('**/admin/quote/estimate', async (r) => {
    await new Promise((res) => setTimeout(res, 1200));
    return r.fulfill(json({
      total: { cents: 6000, lkr: 'LKR 19,800' }, amountDueNow: { cents: 600, lkr: 'Rs 0' },
      lineItems: [{ label: 'Travel', amountCents: 6000, lkr: 'LKR 19,800' }],
      breakdown: { km: { distanceKm: 120, bufferKm: 0, billableKm: 120 }, legs: [{ priceCents: 6000 }] },
      fxUsdToLkr: 330, warnings: [],
      services: { pointToPoint: { total: { cents: 6000, lkr: 'LKR 19,800' } }, chauffeur: { error: 'single-day trip' } },
    }));
  });

  await page.route('**/admin/quote/q_review', (r) => {
    if (r.request().method() === 'PATCH') {
      rec.patches.push(r.request().postDataJSON());
      return r.fulfill(json({ id: 'q_review', status: 'ready' }));
    }
    return r.fulfill(json({
      id: 'q_review', reference: 'Q-REVW', status: 'pending_review',
      customerName: 'Maya Silva', customerContact: '+94770000000',
      totalCents: 6000, currency: 'USD',
      request: { tool: TOOL }, requestedService: 'private',
      assignedTo: 'f@e2e.test', createdBy: 'f@e2e.test',
    }));
  });
}

const openWith = async (page, over) => {
  await page.route('**/admin/quote/q_review', (r) => r.fulfill(json(Object.assign({
    id: 'q_review', reference: 'Q-REVW', status: 'draft',
    customerName: 'Maya Silva', customerContact: '+94770000000',
    totalCents: 6000, currency: 'USD',
    request: { tool: TOOL }, requestedService: 'private',
    assignedTo: 'f@e2e.test', createdBy: 'f@e2e.test',
  }, over))));
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 15000 });
  await page.evaluate(() => QuoteView.openQuote('q_review'));
  await page.waitForTimeout(900);
};
const minsAgo = (m) => new Date(Date.now() - m * 60000).toISOString();

test('warns when someone else was editing the same quote moments ago', async ({ page }) => {
  const rec = { patches: [] };
  await stub(page, rec);
  await openWith(page, { updatedBy: 'alice@e2e.test', updatedAt: minsAgo(4) });
  const notice = page.locator('.ch-concurrent');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText(/4 minutes ago/);
  // Soft, not a lock: the builder must still be editable.
  await expect(page.locator('#quoteRoot [data-field="stop"]').first()).toBeEnabled();
});

test('stays quiet for your own edit, a stale one, or a quote nobody has touched', async ({ page }) => {
  const rec = { patches: [] };
  await stub(page, rec);

  // Your own last save is not a clash — the stub signs in as f@e2e.test.
  await openWith(page, { updatedBy: 'f@e2e.test', updatedAt: minsAgo(2) });
  await expect(page.locator('.ch-concurrent')).toHaveCount(0);

  // Someone else, but long ago — they have gone home.
  await openWith(page, { updatedBy: 'alice@e2e.test', updatedAt: minsAgo(90) });
  await expect(page.locator('.ch-concurrent')).toHaveCount(0);

  // Never edited.
  await openWith(page, { updatedBy: null, updatedAt: null });
  await expect(page.locator('.ch-concurrent')).toHaveCount(0);
});
