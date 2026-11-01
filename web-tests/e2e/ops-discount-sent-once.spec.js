import { test, expect } from '@playwright/test';

// The founder's discount is sent on the save AFTER Apply/Remove, and never again (2026-11-01).
// _discountTouched used to stay true for the rest of the session, so every autosave re-sent the
// discount as a fresh apply: a "replaced" history row per save (Q-DWT4M: three in 3s), and —
// worse — a service switch in the same session re-applied it to the new service, because the
// server only drops a discount on a save that does NOT mention one (Q-GYJ89). Fully stubbed.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

async function stubOps(page, saves, reply = () => ({})) {
  await page.addInitScript(() => {
    function MapCls() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: MapCls,
        places: {
          AutocompleteSessionToken: function () {},
          AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) },
        },
        importLibrary: async () => ({}),
      },
    };
  });

  // Catch-all FIRST; specific routes after (Playwright: last-registered wins).
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) =>
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage', 'discount:apply_manual'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/ops/users', (r) => r.fulfill(json({ users: [] })));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/quote/places**', (r) => r.fulfill(json({ places: [], suggestions: [] })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 180 })));
  await page.route('**/admin/quote/draft', (r) =>
    r.fulfill(json({ id: 'row1', reference: 'Q-ROW1', status: 'draft', assignedTo: 'founder@e2e.test' })));
  await page.route('**/admin/quote/save', (r) => {
    saves.push(r.request().postDataJSON() || {});
    return r.fulfill(json({
      id: 'row1', reference: 'Q-ROW1', status: 'draft',
      totalCents: 6000, legs: [{ distanceKm: 120, segmentKms: [120] }],
      ...reply(saves.length),
    }));
  });
  // A valid-shaped estimate is REQUIRED: an empty {} makes the money-card renderer throw on
  // est.total.cents, which aborts render() (see ops-typed-distance.spec.js).
  await page.route('**/admin/quote/estimate', (r) => {
    const b = r.request().postDataJSON() || {};
    const km = (b.legs && b.legs[0] && b.legs[0].distanceKm) || 0;
    const priceCents = km * 50;
    return r.fulfill(json({
      total: { cents: priceCents, lkr: 'Rs ' + (priceCents * 3) },
      amountDueNow: { cents: Math.round(priceCents / 10), lkr: 'Rs 0' },
      lineItems: [{ label: 'Colombo → Kandy', amountCents: priceCents, lkr: 'Rs 0' }],
      breakdown: { km: { distanceKm: km, bufferKm: 0, billableKm: km }, legs: [{ priceCents }] },
      fxUsdToLkr: 320,
      warnings: [],
      services: {
        pointToPoint: { total: { cents: priceCents, lkr: 'Rs 0' } },
        chauffeur: { error: 'single-day trip — point-to-point only' },
      },
    }));
  });
}

// Build a priceable quote, Save it, and settle: savedId bound, _dirty false, chip "Saved".
async function buildAndSave(page, saves) {
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view [data-qnew]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'karen');
  const from = '.ch-tl-title[data-field="stop"][data-stop="0"]';
  const to = '.ch-tl-title[data-field="stop"][data-stop="1"]';
  await page.locator(from).first().fill('Colombo');
  await page.dispatchEvent(from, 'change');
  await page.locator(to).first().fill('Kandy');
  await page.dispatchEvent(to, 'change');
  await expect(page.locator('.ch-dist-pill.auto').first()).toContainText('120 km', { timeout: 5000 });
  await page.locator('[data-action="saveDraft"]').click();
  await expect(page.locator('#ch-savestate')).toContainText('Saved', { timeout: 5000 });
  // Let any armed autosave debounce (2.5s) drain so the edits below own the next /save.
  await page.waitForTimeout(3000);
  saves.length = 0;
}

async function applyDiscount(page) {
  const box = page.locator('[data-testid="discount-control"]');
  await box.locator('[data-discount-value]').fill('5');
  await box.locator('[data-discount-reason]').fill('closing');
  await box.locator('[data-action="applyDiscount"]').click();
}

test('the discount rides the save after Apply, and later autosaves preserve it instead', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves);
  await buildAndSave(page, saves);

  await applyDiscount(page);
  await expect.poll(() => saves.length, { timeout: 8000 }).toBe(1);
  expect(saves[0].discount).toMatchObject({ method: 'fixed', amountCents: 500, reason: 'closing' });

  await page.fill('#f-firstName', 'Devan');
  await expect.poll(() => saves.length, { timeout: 8000 }).toBe(2);
  expect(saves[1].firstName).toBe('Devan');
  expect('discount' in saves[1]).toBe(false); // absent = preserve, so the server's service check applies
});

test('a dropped discount is cleared on screen and announced as a warning', async ({ page }) => {
  const saves = [];
  // The server dropped the discount because the priced service changed.
  await stubOps(page, saves, (n) => (n === 1 ? { discountRemoved: true } : {}));
  await buildAndSave(page, saves);

  await page.fill('#f-firstName', 'Devan');
  await expect.poll(() => saves.length, { timeout: 8000 }).toBe(1);

  const toast = page.locator('#ch-toast');
  await expect(toast).toHaveClass(/show/);
  await expect(toast).toHaveClass(/bad/);
  await expect(toast).toContainText('Discount removed');
  // Nothing left to re-send: the control is back to empty (no Remove button).
  await expect(page.locator('[data-testid="discount-control"] [data-action="removeDiscount"]')).toHaveCount(0);
});
