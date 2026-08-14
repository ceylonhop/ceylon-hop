import { test, expect } from '@playwright/test';

// Customer-field edits must arm autosave (found 2026-08-13, verified live): the fieldMap input
// handlers for f-firstName / f-lastName / f-contact / pax / bags updated state but never called
// markDirty(), so a rename armed no autosave and the chip kept saying "Saved" — the edit was
// silently unsaved until some OTHER edit or an explicit Save carried it. A renamed customer
// could be lost by navigating away, and a reviewer could approve content the operator believed
// they had changed. Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

async function stubOps(page, saves) {
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
    r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
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
  await page.fill('#f-lastName', 'Senarath');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
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

test('editing only the customer name arms autosave and persists', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves);
  await buildAndSave(page, saves);

  await page.fill('#f-firstName', 'Devan');

  // The edit must read as unsaved…
  await expect(page.locator('#ch-savestate')).not.toContainText('Saved', { timeout: 3000 });
  // …and the autosave must carry it, bound to the same row.
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(saves[0].firstName).toBe('Devan');
  expect(saves[0].id).toBe('row1');
});

test('editing only pax arms autosave and persists', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves);
  await buildAndSave(page, saves);

  await page.fill('#f-passengerCount', '3');
  await page.dispatchEvent('#f-passengerCount', 'change');

  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  expect(saves[0].passengerCount).toBe(3);
  expect(saves[0].id).toBe('row1');
});
