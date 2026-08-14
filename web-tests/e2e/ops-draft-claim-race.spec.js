import { test, expect } from '@playwright/test';

// Draft-claim race (reproduced 2026-08-13): "+ New quote" claims a $0 shell row in the
// background (POST /admin/quote/draft) and binds the builder to it when the response lands.
// The only staleness guard was _openSeq, which changes on reopen / new — NOT on save. So when
// the claim response arrived late (cold API) and the operator's first save had already landed,
// the save — carrying no id — INSERTED a real quote, and the late claim then silently rebound
// the builder to the empty shell. Every later save wrote the on-screen content into the shell
// (a near-identical duplicate), and the assign picker PATCHed the shell instead of the quote
// the operator submitted. claimDraftRow must drop a claim that lands after the session already
// has a row, and delete the now-redundant shell.
//
// Stages the race deterministically: hold /draft, build + Save (insert → Q-REAL1), then
// release the held claim. Fully stubbed — no DB, no Google key.

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (obj) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(obj) });

async function stubOps(page) {
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

test('a draft claim landing after the first save must not rebind the session to the shell', async ({ page }) => {
  await stubOps(page);

  // The shell claim is HELD until the test releases it — the "slow response".
  let releaseClaim;
  const claimHeld = new Promise((res) => { releaseClaim = res; });
  await page.route('**/admin/quote/draft', async (r) => {
    await claimHeld;
    await r.fulfill(json({ id: 'shell1', reference: 'Q-SHELL1', status: 'draft', assignedTo: 'founder@e2e.test' }));
  });

  // Record every save body and any DELETE, to assert where writes actually went.
  const saves = [];
  await page.route('**/admin/quote/save', (r) => {
    const body = r.request().postDataJSON() || {};
    saves.push(body);
    return r.fulfill(json({
      id: 'real1', reference: 'Q-REAL1', status: 'draft', assignedTo: 'founder@e2e.test',
      totalCents: 6000, legs: [{ distanceKm: 120, segmentKms: [120] }],
    }));
  });
  const deletes = [];
  await page.route('**/admin/quote/shell1', (r) => {
    if (r.request().method() === 'DELETE') { deletes.push(r.request().url()); return r.fulfill(json({ ok: true })); }
    return r.fulfill(json({}));
  });

  await page.goto(OPS_FILE + '#quotes');

  // "+ New quote" — the claim goes out and hangs.
  await page.locator('#view [data-qnew]').click();
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });

  // Build fast: vehicle, name, a typed leg with a stubbed distance — then Save. The save has
  // no id (the claim never landed), so the server inserts and returns Q-REAL1.
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
  await expect(page.locator('#quoteRoot .ch-app')).toContainText('Q-REAL1', { timeout: 5000 });
  expect(saves[0] && saves[0].id).toBeUndefined(); // the insert — the claim hadn't landed

  // NOW the stale claim finally arrives.
  releaseClaim();

  // CONTRACT 1: the builder keeps the row it saved — the late shell must not rebind it.
  await expect(page.locator('#quoteRoot .ch-app')).toContainText('Q-REAL1', { timeout: 5000 });
  await expect(page.locator('#quoteRoot .ch-app')).not.toContainText('Q-SHELL1');

  // CONTRACT 2: the redundant shell is deleted so it can't clutter the queue.
  await expect.poll(() => deletes.length, { timeout: 5000 }).toBe(1);

  // CONTRACT 3: the next save still targets the inserted row, not the shell.
  await page.fill('#f-firstName', 'Devan');
  await page.locator('[data-action="saveDraft"]').click();
  await expect.poll(() => saves.length, { timeout: 5000 }).toBe(2);
  expect(saves[1].id).toBe('real1');
});
