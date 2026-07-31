import { test, expect } from '@playwright/test';

// Trip calendar (2026-07-30): the date span is the chauffeur price, so the builder now
// (a) renders the span as a strip of day tiles with an explicit all-clear / warning, and
// (b) moves day-to-day date entry onto ± steppers and one-tap chips so a month can't be
// fat-fingered. Offline spec — stubbed API, static server, same recipe as
// ops-chauffeur-date.spec.js.
//
// All dates are COMPUTED from today (base = +45 days) — never literals, which rot into
// the date-bombs logged in docs/known-bugs.md (2026-07-25).

const OPS_FILE = '/api/src/routes/ops-ui.html';

// One worker for this file (overrides the config's fullyParallel): each test boots the whole
// ops SPA and drives a build with constantly re-rendering DOM — five instances contending for
// CPU is exactly the parallel-load flake mode documented for the other ops specs in
// docs/known-bugs.md (2026-07-25). Sequential in one worker, this file is deterministic.
test.describe.configure({ mode: 'default' });

const iso = (d) => d.toISOString().slice(0, 10);
const plusDays = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return iso(d); };
const BASE = 45; // comfortably future, immune to the legDateFloor "today" clamp

async function stubOps(page) {
  await page.addInitScript(() => {
    function DS() {}
    DS.prototype.route = function (req, cb) { cb({ routes: [{ legs: [{ distance: { value: 120000 }, duration: { value: 7200 } }] }] }, 'OK'); };
    function DR() {} DR.prototype.setMap = function () {}; DR.prototype.setDirections = function () {};
    function M() {}
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: M, DirectionsService: DS, DirectionsRenderer: DR, TravelMode: { DRIVING: 'DRIVING' },
        places: { AutocompleteSessionToken: function () {}, AutocompleteSuggestion: { fetchAutocompleteSuggestions: async () => ({ suggestions: [] }) } },
        importLibrary: async () => ({}) },
    };
  });
  const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'founder@e2e.test', role: 'founder', caps: ['quote:manage'] })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json({
    rateCardVersion: '2026-07-09',
    perKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
    floorCents: { car: 2900, van: 5000, van9: 5000, van14: 8500, custom: 11000 },
    chauffeurDayRateCents: 3500, fxUsdToLkr: 330, bufferPct: 10,
  })));
  await page.route('**/admin/quote/distance', (r) => r.fulfill(json({ km: 120, durationMin: 150 })));
}

async function setLegDate(page, legIndex, value) {
  // Self-healing, not sleep-based: a background estimate/autosave render can land mid-edit
  // and swallow the change (the builder's _renderSwapping guard drops render-artifact
  // events). If that happens the next diff-render resets the input to the OLD state value,
  // so asserting the value stuck — and retrying the whole edit until it does — converges
  // under any CPU load. This is the pattern the flaky specs in docs/known-bugs.md lack.
  const input = () => page.locator('.ch-leg').nth(legIndex).locator('[data-field="date"]');
  await expect(async () => {
    await input().fill(value);
    await input().dispatchEvent('change');
    await page.waitForTimeout(60);
    await expect(input()).toHaveValue(value, { timeout: 500 });
  }).toPass({ timeout: 15000 });
}

// Build the shared fixture: basics + 4 legs dated +45, +46, +48, +50 (6-day span, 2 idle).
async function buildTrip(page, { dates = [BASE, BASE + 1, BASE + 3, BASE + 5] } = {}) {
  await stubOps(page);
  await page.goto(OPS_FILE + '#quote');
  await page.waitForSelector('#quoteRoot .ch-app', { timeout: 10000 });
  await page.locator('[data-action="setVehicle"][data-veh="car"]').dispatchEvent('click');
  await page.fill('#f-firstName', 'Test');
  await page.fill('#f-contact', '+94771234567');
  await page.dispatchEvent('#f-contact', 'change');
  const stops = [['Colombo Airport', 'Sigiriya'], ['Sigiriya', 'Kandy'], ['Kandy', 'Ella'], ['Ella', 'Galle']];
  // Grow to exactly 4 legs, COUNT-DRIVEN (the builder seeds leg 1 itself — state.legs
  // starts as [newLeg()]), and via DISPATCHED clicks: the background estimate/autosave
  // renders in this stubbed environment re-render constantly, and a trusted click races the
  // mousedown→mouseup node replacement (the documented flake in docs/known-bugs.md
  // 2026-07-25). A dispatched click re-resolves the node at fire time; the app has exactly
  // one delegated [data-action] handler, so it fires the action exactly once.
  await page.waitForTimeout(200);
  // Even a dispatched click is swallowed if its node detaches mid-morph, so the loop is
  // act-then-verify: check the count, click once, verify it grew, and let toPass retry the
  // whole beat until 4 legs exist.
  await expect(async () => {
    const n = await page.locator('.ch-leg').count();
    if (n >= 4) return;
    await page.locator('[data-action="addLeg"]').first().dispatchEvent('click');
    await expect(page.locator('.ch-leg')).toHaveCount(n + 1, { timeout: 600 });
    if (n + 1 < 4) throw new Error('keep adding');
  }).toPass({ timeout: 20000 });
  for (let i = 0; i < 4; i++) {
    const card = page.locator('.ch-leg').nth(i);
    for (const [si, place] of [[0, stops[i][0]], [1, stops[i][1]]]) {
      const inp = card.locator(`[data-field="stop"][data-stop="${si}"]`);
      await inp.fill(place);
      await inp.dispatchEvent('change');
    }
  }
  for (let i = 0; i < 4; i++) {
    if (dates[i] != null) await setLegDate(page, i, plusDays(dates[i]));
  }
}

test('the strip renders the span, one tile per day, and gives the all-clear', async ({ page }) => {
  test.slow();
  await buildTrip(page);
  const cal = page.locator('#trip-cal');
  await expect(cal).toBeVisible();
  await expect(cal.locator('.ch-cal-sum')).toContainText('6 days');
  await expect(cal.locator('.ch-cal-sum')).toContainText('4 driving legs');
  await expect(cal.locator('.ch-cal-ok')).toContainText('every leg dated'); // goal 2: visibly no mistakes
  await expect(cal.locator('.ch-cal-cell')).toHaveCount(6);
  await expect(cal.locator('.ch-cal-cell.idle')).toHaveCount(2);
  // Day tags cross-reference the cards to the strip.
  await expect(page.locator('.ch-leg').nth(0).locator('.ch-day-tag')).toHaveText('Day 1');
  await expect(page.locator('.ch-leg').nth(3).locator('.ch-day-tag')).toHaveText('Day 6');
});

test('steppers nudge a day at a time and clamp at the neighbouring leg', async ({ page }) => {
  test.slow();
  await buildTrip(page);
  // + on the last leg: 6-day span becomes 7. Idempotence-guarded retry: only click while
  // the date hasn't moved yet, so a swallowed click retries and a landed one never doubles.
  const stepUp = (i) => page.locator('.ch-leg').nth(i).locator('[data-action="stepDate"][data-dir="1"]');
  const dateOf = (i) => page.locator('.ch-leg').nth(i).locator('[data-field="date"]');
  // Verify on the value ATTRIBUTE, not the property: the attribute is what render() writes
  // from state, so it is the committed truth; the property can lag it for a beat mid-morph.
  const stepTo = async (i, target) => expect(async () => {
    if ((await dateOf(i).getAttribute('value')) !== target) await stepUp(i).dispatchEvent('click');
    await expect(dateOf(i)).toHaveAttribute('value', target, { timeout: 600 });
  }).toPass({ timeout: 15000 });
  await stepTo(3, plusDays(BASE + 6));
  await expect(page.locator('#trip-cal .ch-cal-sum')).toContainText('7 days');
  // + on leg 1 up to leg 2's day is legal; one more must clamp, not reorder the trip.
  await stepTo(0, plusDays(BASE + 1));
  await stepUp(0).dispatchEvent('click');
  await page.waitForTimeout(250);
  await stepUp(0).dispatchEvent('click'); // belt-and-braces against one swallowed click
  await page.waitForTimeout(250);
  await expect(dateOf(0)).toHaveAttribute('value', plusDays(BASE + 1)); // clamped — order intact
});

test('a fat-fingered month turns the strip amber and names the gap', async ({ page }) => {
  test.slow();
  await buildTrip(page);
  await setLegDate(page, 2, plusDays(BASE + 33)); // leg 3 lands a month late
  const cal = page.locator('#trip-cal');
  await expect(cal.locator('[data-testid="cal-warn"]')).toBeVisible();
  await expect(cal.locator('[data-testid="cal-warn"]')).toContainText('a date is off');
  await expect(cal.locator('.ch-cal-cell.collapsed')).toBeVisible(); // the "+N empty days" tile
});

test('an undated leg offers one-tap chips instead of a guessed date', async ({ page }) => {
  test.slow();
  await buildTrip(page, { dates: [BASE, BASE + 1, BASE + 3, null] });
  const cal = page.locator('#trip-cal');
  await expect(cal.locator('.ch-cal-note')).toContainText('1 leg still undated');
  const last = page.locator('.ch-leg').nth(3);
  await expect(last.locator('.ch-date-chip')).toHaveCount(2); // same day / next day
  await expect(async () => {
    const l = page.locator('.ch-leg').nth(3);
    if (await l.locator('[data-action="setDateRel"][data-rel="1"]').count()) {
      await l.locator('[data-action="setDateRel"][data-rel="1"]').dispatchEvent('click');
    }
    await expect(l.locator('[data-field="date"]')).toHaveValue(plusDays(BASE + 4), { timeout: 500 });
  }).toPass({ timeout: 15000 });
  await expect(cal.locator('.ch-cal-ok')).toBeVisible();
});

test('collapsing to a single day states the point-to-point revert instead of staying silent', async ({ page }) => {
  test.slow();
  await buildTrip(page, { dates: [BASE, BASE, BASE, BASE] });
  await expect(page.locator('#trip-cal .ch-cal-note')).toContainText('priced point-to-point');
});
