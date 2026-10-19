import { test, expect } from '@playwright/test';

// A half-filled leg is a normal in-progress state, not a failure (staging, 2026-10-16): with From
// picked and To still empty, autosave POSTed /admin/quote/save, the server refused it (400 "couldn't
// find the distance for Colombo -> ?") and the chip turned red "Autosave failed -- use Save" until the
// leg was finished. A chip that cries wolf trains ops to ignore a real failure. The builder now
// holds autosave back while a driving leg lacks an end, and a REAL failure (5xx, a 400 on a
// complete draft) still shows red. Fully stubbed -- no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (obj, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(obj) });
const SAVED = { id: 'row1', reference: 'Q-ROW1', status: 'draft', totalCents: 6000, legs: [{ distanceKm: 120, segmentKms: [120] }] };
const NO_DISTANCE = { error: "couldn't find the distance for Colombo \u2192 ? \u2014 enter the km manually" };

async function stubOps(page, saves, saveAnswer) {
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
    const body = r.request().postDataJSON() || {};
    saves.push(body);
    return r.fulfill(saveAnswer(body));
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


// A new quote with a vehicle and customer filled, then ONLY the From stop typed -- the To stays empty.
async function startHalfFilled(page) {
  await page.goto(OPS_FILE + '#quotes');
  await page.locator('#view [data-qnew]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').click();
  await page.fill('#f-firstName', 'karen');
  const from = '.ch-tl-title[data-field="stop"][data-stop="0"]';
  await page.locator(from).first().fill('Colombo');
  await page.dispatchEvent(from, 'change');
}
async function finishLeg(page) {
  const to = '.ch-tl-title[data-field="stop"][data-stop="1"]';
  await page.locator(to).first().fill('Kandy');
  await page.dispatchEvent(to, 'change');
}
const chip = (page) => page.locator('#ch-savestate');
// Longer than the 2.5s autosave debounce, so an armed autosave would have fired and answered.
const pastDebounce = (page) => page.waitForTimeout(4000);
const refuseIfNoTo = (body) => (body.legs.some((l) => !l.to) ? json(NO_DISTANCE, 400) : json(SAVED));

test('a half-filled leg is not a failure: no request, no red chip, then it saves once the leg is complete', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves, refuseIfNoTo);
  await startHalfFilled(page);
  await pastDebounce(page);
  await expect(chip(page)).not.toContainText('Autosave failed');
  expect(saves).toEqual([]); // nothing the server would refuse was sent
  await expect(chip(page)).toContainText(/Unsaved|Edits pending/); // still honest that nothing is saved

  await finishLeg(page);
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  await expect(chip(page)).toContainText('Saved', { timeout: 5000 });
});

test('a server error on a complete draft still shows the red Autosave failed', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves, () => json({ error: 'internal' }, 500));
  await startHalfFilled(page);
  await finishLeg(page);
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  await expect(chip(page)).toContainText('Autosave failed');
});

test('a 400 on a complete draft still shows the red Autosave failed', async ({ page }) => {
  const saves = [];
  await stubOps(page, saves, () => json({ error: 'a stop can\'t be the same as the one before it' }, 400));
  await startHalfFilled(page);
  await finishLeg(page);
  await expect.poll(() => saves.length, { timeout: 8000 }).toBeGreaterThan(0);
  await expect(chip(page)).toContainText('Autosave failed');
});
