# Ops Rates page — PR 4 (the edit form) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On the Rates page the founder edits every price the spec makes editable (§6), reviews
the change and saves it as a new revision. The review lists old → new, flags anything below cost
or over 20%, and prices four sample trips. The page also shows the history, which can revert to
any earlier version or to the code defaults. Deposit % and cap stay read-only. Ops and finance
still can't reach the page, and a viewer without `rates:manage` sees it read-only.

**Architecture:**
- **Data.** The Rates page section of `QuoteView` (`api/src/routes/ops-ui.html`, from PR 1) stops
  drawing the builder's sell-only card (`GET /admin/quote/rate-card`) and reads the founder API
  instead (`GET /admin/rates` from PR 2). That API carries the live set, the defaults, the history
  and the read-only deposit.
- **View and edit.** One renderer draws the existing two-column `.ch-rate-*` rows with either values
  or `.ch-field` inputs. Per-km figures are exact (`$0.4025`).
- **Draft handling.** The form is uncontrolled and **never re-rendered while open**: morphdom skips
  `#rt-form`. Field errors and live margins are written straight onto the DOM.
- **Review and save.** The review is a `.ch-modal`. It prices samples through `POST
  /admin/rates/preview` and saves through `POST /admin/rates` (`baseVersion`, optional
  `revertedToVersion`), handling 201, 409 and 400.

**Tech Stack:** single-file ops UI (ES5 inside `QuoteView`, vendored morphdom), Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-09-26-ops-rates-page-design.md` §6–§7, §10 (PR 4).

## Global Constraints

- **Limits and precision** are the server's (`api/src/quote/rateRevision.ts`), mirrored client-side
  for early errors. The server stays authoritative, and a 400 is shown in the dialog.
  - Per-km price and cost: > 0, ≤ $10, ≤ 4 decimals of a dollar.
  - Minimum fares and day rate/cost: whole cents, ≤ $1000.
  - Add-ons: whole cents, ≤ $500.
  - Buffer: a whole number, 0–50.
  - FX: > 0, ≤ 1000, ≤ 2 decimals.
- **An untouched field must round-trip exactly:** 54.05¢ goes out as 54.05. `rtCents` computes
  `Math.round(dollars × 10000) / 100`.
- **Deposit is read-only in both modes** (owner decision 7).
- **Permissions:**
  - The Edit and Revert buttons show only with `rates:manage`.
  - The page itself stays `margin:view` (PR 1).
- **The hot-zones panel is unchanged** and stays on the page.
- **Tests:** red, then green. Run `cd web-tests && npm run test:all` and `cd api && npm run check`
  before the PR, and read the real exit codes.
- **Worktree:**
  `/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad/wt-rates4`,
  branch `feat/ops-rates-edit`.

---

### Task 1: The editor

**Files:**
- Modify: `api/src/routes/ops-ui.html`:
  - delete `renderRateCardBody()` (it was only used by the Rates page)
  - replace the whole `// ── Rates page (spec 2026-09-26 §5)` section, from `ratesToast` through
    the page's click delegate
  - in the CSS, replace `.qv .ch-rates-head {…}` with the editor rules
- Test: `web-tests/e2e/ops-rates-edit.spec.js` (new), and `web-tests/e2e/ops-rates-page.spec.js`
  (stub `GET /admin/rates`; expect "Price per km" and `$0.4025`)

**Interfaces — Consumes:**
- `GET /admin/rates` → `{ live: { version, source, rates, createdBy, createdAt }, defaults: { version, rates }, history: [{ id, seq, version, rates, revertedToVersion, createdBy, createdAt }], readOnly: { depositPct, depositCapCents } }`
- `POST /admin/rates/preview` `{ rates }` → `{ samples }`
- `POST /admin/rates` `{ baseVersion, rates, revertedToVersion? }` → 201 `{ revision }` | 409 `{ error: 'stale_rates', current }` | 400 `{ issues }`

These were shipped in #813.

- [ ] **Step 1: Write the failing e2e spec** — `web-tests/e2e/ops-rates-edit.spec.js`:

```js
import { test, expect } from '@playwright/test';

// Rates editor (spec 2026-09-26 §6–§7, PR 4): the founder sets prices on the Rates page through a
// review step; every save is a revision the history can revert. Offline: GET/POST /admin/rates and
// /admin/rates/preview are stubbed (the API's own rules — limits, stale-base 409, founder-only —
// are covered by api's opsRates.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view', 'rates:manage'];
const RATES = {
  perKmCents: { car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 },
  costPerKmCents: { car: 35, van: 47, van9: 47, van14: 48, custom: 175 },
  floorCents: { car: 2900, van: 4999, van9: 4999, van14: 8500, custom: 11000 },
  dayRateCents: 3105,
  dayRateCostCents: 2700,
  extrasCents: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  bufferPct: 10,
  fxUsdToLkr: 330,
};
const withCar = (car) => ({ ...RATES, perKmCents: { ...RATES.perKmCents, car } });
const defaultsBody = () => ({
  live: { version: '2026-07-14', source: 'defaults', rates: RATES, createdBy: null, createdAt: null },
  defaults: { version: '2026-07-14', rates: RATES },
  history: [],
  readOnly: { depositPct: 10, depositCapCents: 5000 },
});
const revision = (seq, day, rates, extra = {}) => ({
  id: 'r' + seq, seq, version: `2026-09-${day}.${seq}`, rates, revertedToVersion: null,
  createdBy: 'roshen@ceylonhop.com', createdAt: `2026-09-${day}T10:05:00.000Z`, ...extra,
});
const SAMPLES = [
  { label: '30 km car transfer', currentCents: 2900, proposedCents: 2900 },
  { label: '150 km car transfer', currentCents: 6650, proposedCents: 7400 },
  { label: '150 km van transfer', currentCents: 8900, proposedCents: 8900 },
  { label: '3-day car chauffeur trip, 3 × 100 km', currentCents: 22800, proposedCents: 24000 },
];

// Boots the founder shell on #rates. `body()` answers GET /admin/rates (called again after a save);
// `save` answers POST /admin/rates. Every POST body is recorded.
async function boot(page, { caps = FOUNDER, body = defaultsBody, save } = {}) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: { Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {}, TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}) },
    };
  });
  const posts = [];
  let gets = 0;
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'roshen@ceylonhop.com', role: 'founder', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/quote/zones', (r) => r.fulfill(json({ zones: [], disabled: false })));
  await page.route('**/admin/rates/preview', (r) => r.fulfill(json({ samples: SAMPLES })));
  await page.route('**/admin/rates', (r) => {
    if (r.request().method() === 'GET') { gets++; return r.fulfill(json(body(gets))); }
    posts.push(r.request().postDataJSON());
    return r.fulfill(save ? save(posts.at(-1)) : json({ revision: revision(1, 27, posts.at(-1).rates) }, 201));
  });
  await page.goto(OPS_FILE + '#rates');
  await expect(page.locator('[data-testid="rates-live"]')).toBeVisible({ timeout: 10000 });
  return { posts, gets: () => gets };
}
const review = (page) => page.locator('[data-testid="rates-review"]');

test('view: exact per-km prices, margins, and a read-only deposit', async ({ page }) => {
  await boot(page);
  const pageEl = page.locator('[data-testid="rates-page"]');
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('code defaults');
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('2026-07-14');
  await expect(pageEl).toContainText('$0.4025');
  await expect(pageEl).toContainText('$0.5405');
  await expect(pageEl).toContainText('$0.552');
  await expect(page.locator('[data-margin-for="car"]')).toHaveText('margin 15%');
  await expect(page.locator('[data-margin-for="day"]')).toHaveText('margin 15%');
  await expect(pageEl).toContainText('not charged — bookings are paid in full');
  await expect(page.locator('[data-action="rtEdit"]')).toBeVisible();
  await expect(page.locator('[data-testid="rates-history-defaults"]')).toContainText('Code defaults');
});

test('edit → review lists only what changed → save posts the exact set and shows the new version', async ({ page }) => {
  const saved = revision(1, 27, { ...withCar(45), extrasCents: { ...RATES.extrasCents, waiting: 1200 } });
  const { posts, gets } = await boot(page, {
    body: (n) => (n === 1 ? defaultsBody() : { ...defaultsBody(), live: { version: saved.version, source: 'revision', rates: saved.rates, createdBy: saved.createdBy, createdAt: saved.createdAt }, history: [saved] }),
  });
  await page.click('[data-action="rtEdit"]');
  await expect(page.locator('#rt-km-car')).toHaveValue('0.4025'); // exact, not the rounded $0.40
  await page.fill('#rt-km-car', '0.45');
  await expect(page.locator('[data-margin-for="car"]')).toHaveText('margin 28.6%'); // follows the typing
  await page.fill('#rt-x-waiting', '12');
  await page.click('[data-action="rtReview"]');

  await expect(review(page)).toBeVisible();
  const rows = page.locator('[data-testid="rates-changes"] tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('Car — price per km');
  await expect(rows.nth(0)).toContainText('$0.4025');
  await expect(rows.nth(0)).toContainText('$0.45');
  await expect(rows.nth(1)).toContainText('Waiting');
  await expect(rows.nth(1)).toContainText('$12.00');
  await expect(page.locator('[data-testid="rates-samples"] tbody tr')).toHaveCount(4);

  await page.click('[data-action="rtSave"]');
  await expect(review(page)).toHaveCount(0);
  expect(posts).toHaveLength(1);
  expect(posts[0].baseVersion).toBeNull();
  expect(posts[0]).not.toHaveProperty('revertedToVersion');
  // Every untouched figure goes back exactly as it came (54.05, 55.2, 201.25 …), the two edits as typed.
  expect(posts[0].rates).toEqual({ ...withCar(45), extrasCents: { ...RATES.extrasCents, waiting: 1200 } });
  await expect(page.locator('[data-testid="rates-live"]')).toContainText('2026-09-27.1');
  expect(gets()).toBe(2);
  await expect(page.locator('#rt-km-car')).toHaveCount(0); // back to the read view
});

test('the review flags a price below cost and a jump of more than 20%', async ({ page }) => {
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.30');
  await page.click('[data-action="rtReview"]');
  await expect(page.locator('[data-testid="rates-below-cost"]')).toContainText('Car: the price per km is below our cost');
  await expect(page.locator('[data-testid="rates-changes"] tbody tr.is-big')).toHaveCount(1);
});

test('a malformed figure is caught before the review opens', async ({ page }) => {
  const { posts } = await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.40255');
  await page.click('[data-action="rtReview"]');
  await expect(review(page)).toHaveCount(0);
  await expect(page.locator('#rt-km-car')).toHaveClass(/invalid/);
  await expect(page.locator('#rt-km-car').locator('xpath=ancestor::div[contains(@class,"ch-field")][1]').locator('.ch-field-err')).toContainText('4 decimals');
  await page.fill('#rt-km-car', '0.4025'); // fixing it clears the error
  await expect(page.locator('#rt-km-car')).not.toHaveClass(/invalid/);
  expect(posts).toHaveLength(0);
});

test('nothing changed: the review says so and will not save', async ({ page }) => {
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.click('[data-action="rtReview"]');
  await expect(page.locator('[data-testid="rates-no-change"]')).toBeVisible();
  await expect(page.locator('[data-action="rtSave"]')).toBeDisabled();
});

test('a stale save names who saved meanwhile and offers a reload', async ({ page }) => {
  const other = revision(1, 27, withCar(50), { createdBy: 'nimal@ceylonhop.com' });
  const { gets } = await boot(page, { save: () => json({ error: 'stale_rates', current: other }, 409) });
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.45');
  await page.click('[data-action="rtReview"]');
  await page.click('[data-action="rtSave"]');
  await expect(page.locator('[data-testid="rates-stale"]')).toContainText('2026-09-27.1');
  await expect(page.locator('[data-testid="rates-stale"]')).toContainText('nimal');
  await page.click('[data-action="rtReload"]');
  await expect(review(page)).toHaveCount(0);
  expect(gets()).toBe(2);
});

test('history lists what each version changed, and revert saves the old set with its version', async ({ page }) => {
  const r1 = revision(1, 27, withCar(45));
  const r2 = revision(2, 28, withCar(50));
  const { posts } = await boot(page, {
    body: () => ({ ...defaultsBody(), live: { version: r2.version, source: 'revision', rates: r2.rates, createdBy: r2.createdBy, createdAt: r2.createdAt }, history: [r2, r1] }),
  });
  const rows = page.locator('[data-testid="rates-history-row"]');
  await expect(rows).toHaveCount(2);
  await expect(rows.nth(0)).toContainText('2026-09-28.2');
  await expect(rows.nth(0)).toContainText('live');
  await expect(rows.nth(0)).toContainText('Car — price per km $0.45 → $0.50');
  await expect(rows.nth(1)).toContainText('Car — price per km $0.4025 → $0.45');
  await expect(rows.nth(0).locator('[data-action="rtRevert"]')).toHaveCount(0); // the live one
  await rows.nth(1).locator('[data-action="rtRevert"]').click();
  await expect(review(page)).toContainText('Reverting to version 2026-09-27.1');
  await page.click('[data-action="rtSave"]');
  expect(posts[0]).toEqual({ baseVersion: '2026-09-28.2', rates: withCar(45), revertedToVersion: '2026-09-27.1' });
});

test('without rates:manage the page is read-only', async ({ page }) => {
  await boot(page, { caps: FOUNDER.filter((c) => c !== 'rates:manage') });
  await expect(page.locator('[data-action="rtEdit"]')).toHaveCount(0);
  await expect(page.locator('[data-action="rtRevert"]')).toHaveCount(0);
});

test('phone width: the edit form fits the card', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  const poking = await page.locator('.ch-rates-card').evaluate((card) => {
    const edge = card.getBoundingClientRect().right;
    return [...card.querySelectorAll('input, button, .ch-badge, b')]
      .filter((el) => el.getBoundingClientRect().right > edge + 0.5)
      .map((el) => el.id || el.textContent.trim());
  });
  expect(poking).toEqual([]);
});

test('phone width: the review dialog sits above the side rail, not under it', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await page.addInitScript(() => { try { localStorage.setItem('ch_ops_rail', '1'); } catch (e) {} });
  await boot(page);
  await page.click('[data-action="rtEdit"]');
  await page.fill('#rt-km-car', '0.45');
  await page.click('[data-action="rtReview"]');
  // The dialog lived inside #view (z-index 1) under the rail (z-index 2): its left edge was hidden.
  const covered = await page.evaluate(() => {
    const t = document.querySelector('[data-testid="rates-review"] .ch-modal-head h2').getBoundingClientRect();
    const hit = document.elementFromPoint(t.left + 4, t.top + t.height / 2);
    return !(hit && hit.closest('[data-testid="rates-review"]'));
  });
  expect(covered).toBe(false);
});
```

In `web-tests/e2e/ops-rates-page.spec.js`:
- Add a `RATES_BODY` constant and stub `**/admin/rates` with it in `boot()`.
- Change the founder test's expectations to `/Price per km/i` and `$0.4025`.

- [ ] **Step 2: Run and watch it fail**

Run: `cd web-tests && npx playwright test ops-rates-edit ops-rates-page --workers=2; echo "exit=$?"`
Expected: `10 failed | 5 passed`. That is every edit test, plus the page spec's founder test on its
new expectation. Exit ≠ 0.

- [ ] **Step 3: Replace the Rates page section** — delete `function renderRateCardBody() { … }`, then
replace everything from `// ── Rates page (spec 2026-09-26 §5)` through the closing `});` of the
page's `document.addEventListener('click', …)` with:

```js
// ── Rates page (spec 2026-09-26 §5–§7) ───────────────────────────────────────
// Rate Settings used to be a popup over the builder; it is a founder-only page in the ops side
// menu. The shell owns the page header and hands us #rates-mount; the page renders here because it
// shares this module's helpers (api, esc, apiPlaces) and its .qv-scoped CSS. `ratesEl` is non-null
// only while the page is showing — every async repaint checks it, so a response that lands after
// the founder has moved on paints nothing.
//
// The rates come from GET /admin/rates (the live set, the code defaults, the history and the
// read-only deposit) and are saved through a review step as a new revision (POST /admin/rates).
// Per-km figures are shown and edited EXACTLY — two decimals of a cent, $0.4025 — so saving an
// untouched field can never move a price. The form is uncontrolled, like the zone form: values are
// read from the DOM at Review time, and the open form is never re-rendered (see renderRatesPage).
var ratesData = null;       // GET /admin/rates body; null until loaded
var ratesLoadFailed = false;
var ratesEditing = false;   // the edit form is open
var ratesReview = null;     // the open review: { rates, revertedToVersion, changes, warnings, samples, samplesFailed, saving, error }

var RT_VEHICLES = [['car', 'Car'], ['van', 'Van 6'], ['van9', 'Van 9'], ['van14', 'Van 14'], ['custom', 'Custom']];
var RT_EXTRAS = [['sightseeing', 'Sightseeing stops'], ['safari-wait', 'Safari wait'], ['waiting', 'Waiting'],
  ['luggage', 'Luggage rack'], ['front', 'Child seat'], ['flex', 'Flexi ticket']];

function ratesToast(msg, kind) {
  // The builder's own #ch-toast sits inside the hidden #quoteRoot on this route; use the shell's.
  if (window.opsToast) window.opsToast(msg, kind);
}
function rtCanEdit() { return viewerCan('rates:manage'); }
// The version the form was opened on (null = nothing saved yet, the code defaults).
function rtBaseVersion() { return ratesData && ratesData.live.source === 'revision' ? ratesData.live.version : null; }

// "0.4025": up to two decimals of a cent, trailing zeros trimmed to at least two places.
function rtKmPlain(cents) { return (cents / 100).toFixed(4).replace(/(\.\d{2}\d*?)0+$/, '$1'); }
function rtUsdPlain(cents) { return (cents / 100).toFixed(2); }
function rtKm(cents) { return '$' + rtKmPlain(cents); }
function rtUsd(cents) { return '$' + rtUsdPlain(cents); }
function rtLkr(cents, fx) { return 'Rs ' + Math.round((cents * fx) / 100).toLocaleString('en-US'); }
// Markup on cost — the owner's July model — so today's card reads 15% on every vehicle.
function rtMargin(price, cost) { return cost > 0 ? (Math.round(((price - cost) / cost) * 1000) / 10) + '%' : '—'; }
function rtShow(kind, v) {
  if (kind === 'km') return rtKm(v);
  if (kind === 'pct') return v + '%';
  if (kind === 'fx') return 'Rs ' + v;
  return rtUsd(v);
}
function rtWho(email) { return String(email || '').split('@')[0] || 'unknown'; }
function rtWhen(iso) { var s = String(iso || ''); return s ? s.slice(0, 10) + ' ' + s.slice(11, 16) + ' UTC' : ''; }

// Every field that differs between two rate sets, in reading order. A change of more than 20% either
// way is flagged — a slipped decimal point should look alarming before it is saved.
function rtChanges(a, b) {
  var out = [];
  function cmp(label, x, y, kind) {
    if (x === y) return;
    var pct = x ? ((y - x) / x) * 100 : null;
    out.push({ label: label, from: x, to: y, kind: kind, pct: pct, big: pct == null || Math.abs(pct) > 20 });
  }
  RT_VEHICLES.forEach(function (v) {
    cmp(v[1] + ' — price per km', a.perKmCents[v[0]], b.perKmCents[v[0]], 'km');
    cmp(v[1] + ' — our cost per km', a.costPerKmCents[v[0]], b.costPerKmCents[v[0]], 'km');
  });
  RT_VEHICLES.forEach(function (v) { cmp(v[1] + ' — minimum fare', a.floorCents[v[0]], b.floorCents[v[0]], 'usd'); });
  cmp('Driver day rate', a.dayRateCents, b.dayRateCents, 'usd');
  cmp('Our driver day cost', a.dayRateCostCents, b.dayRateCostCents, 'usd');
  RT_EXTRAS.forEach(function (x) { cmp(x[1], a.extrasCents[x[0]], b.extrasCents[x[0]], 'usd'); });
  cmp('Buffer', a.bufferPct, b.bufferPct, 'pct');
  cmp('FX (LKR per USD)', a.fxUsdToLkr, b.fxUsdToLkr, 'fx');
  return out;
}

// A price set below what it costs us is allowed — a promotion is a business call — but said out loud.
function rtBelowCost(r) {
  var out = [];
  RT_VEHICLES.forEach(function (v) {
    if (r.perKmCents[v[0]] < r.costPerKmCents[v[0]]) out.push(v[1] + ': the price per km is below our cost');
  });
  if (r.dayRateCents < r.dayRateCostCents) out.push('The driver day rate is below our day cost');
  return out;
}

function rtVal(id) { var el = document.getElementById(id); return el ? String(el.value).trim().replace(/^\$/, '') : ''; }
// Dollars as typed → cents. `places` = decimals of a dollar allowed: 4 for a per-km figure, else 2.
function rtCents(raw, places) {
  var re = places === 4 ? /^\d+(\.\d{1,4})?$/ : /^\d+(\.\d{1,2})?$/;
  if (!re.test(raw)) return null;
  return Math.round(Number(raw) * 10000) / 100;
}

// Read the form into a rate set, checking each figure against the limits the server enforces
// (api/src/quote/rateRevision.ts). Returns { rates, errors }: rates is null while any field is bad.
function rtReadForm() {
  var errors = {};
  var rates = { perKmCents: {}, costPerKmCents: {}, floorCents: {}, extrasCents: {} };
  function money(id, places, maxCents) {
    var c = rtCents(rtVal(id), places);
    if (c == null) errors[id] = places === 4 ? 'Dollars, up to 4 decimals (0.4025)' : 'Dollars and cents (29.00)';
    else if (c <= 0 || c > maxCents) errors[id] = 'Between $0.01 and ' + rtUsd(maxCents);
    return c;
  }
  RT_VEHICLES.forEach(function (v) {
    rates.perKmCents[v[0]] = money('rt-km-' + v[0], 4, 1000);
    rates.costPerKmCents[v[0]] = money('rt-cost-' + v[0], 4, 1000);
    rates.floorCents[v[0]] = money('rt-floor-' + v[0], 2, 100000);
  });
  rates.dayRateCents = money('rt-day', 2, 100000);
  rates.dayRateCostCents = money('rt-daycost', 2, 100000);
  RT_EXTRAS.forEach(function (x) { rates.extrasCents[x[0]] = money('rt-x-' + x[0], 2, 50000); });
  var buf = rtVal('rt-buffer');
  if (!/^\d+$/.test(buf) || Number(buf) > 50) errors['rt-buffer'] = 'A whole percent, 0–50';
  rates.bufferPct = Number(buf);
  var fx = rtVal('rt-fx');
  if (!/^\d+(\.\d{1,2})?$/.test(fx) || Number(fx) <= 0 || Number(fx) > 1000) errors['rt-fx'] = 'Rupees per dollar, up to 2 decimals';
  rates.fxUsdToLkr = Number(fx);
  return { rates: Object.keys(errors).length ? null : rates, errors: errors };
}

// Errors go straight onto the inputs, not through a render: the open form is never re-rendered.
function rtShowErrors(errors) {
  if (!ratesEl) return;
  ratesEl.querySelectorAll('.ch-rt-input').forEach(function (el) {
    var msg = errors[el.id] || '';
    el.classList.toggle('invalid', !!msg);
    var err = el.closest('.ch-field') && el.closest('.ch-field').querySelector('.ch-field-err');
    if (err) err.textContent = msg;
  });
}

function rtInput(id, value, prefix, suffix, label) {
  return '<div class="ch-field"><div class="ch-input-wrap">'
    + (prefix ? '<span class="ch-input-prefix">' + prefix + '</span>' : '')
    + '<input class="ch-input ch-rt-input" id="' + id + '" inputmode="decimal" autocomplete="off" aria-label="' + esc(label) + '" value="' + esc(value) + '">'
    + (suffix ? '<span class="ch-input-suffix">' + suffix + '</span>' : '')
    + '</div><div class="ch-field-err"></div></div>';
}

function renderRatesEditor() {
  if (ratesLoadFailed) {
    return '<div class="ch-lock-note" data-testid="rates-load-failed">Couldn’t load the rates. '
      + '<button class="ch-btn ch-btn-ghost ch-btn-sm" data-action="rtReload">Try again</button></div>';
  }
  if (!ratesData) return '<div style="color:var(--muted);font-size:13px;padding:12px 0">Loading rates…</div>';
  var d = ratesData, r = d.live.rates, fx = r.fxUsdToLkr, edit = ratesEditing;
  function row(label, hint, viewHtml, inputHtml) {
    return '<div class="ch-rate-row">'
      + '<span class="ch-rate-label">' + esc(label) + (hint ? '<span class="ch-rate-hint">' + hint + '</span>' : '') + '</span>'
      + '<span class="ch-rate-control">' + (edit && inputHtml ? inputHtml : viewHtml) + '</span></div>';
  }
  // Value and unit share one line; the rupee equivalent sits under them.
  function view(main, sub) { return '<span class="ch-rt-val"><span>' + main + '</span>' + (sub ? '<small>' + esc(sub) + '</small>' : '') + '</span>'; }

  var perKm = RT_VEHICLES.map(function (v) {
    var c = r.perKmCents[v[0]];
    return row(v[1], null, view(esc(rtKm(c)) + '<i> /km</i>', rtLkr(c, fx) + ' /km'),
      rtInput('rt-km-' + v[0], rtKmPlain(c), '$', '/km', v[1] + ' price per km'));
  }).join('');
  var cost = RT_VEHICLES.map(function (v) {
    var c = r.costPerKmCents[v[0]];
    var m = '<span data-margin-for="' + v[0] + '">margin ' + esc(rtMargin(r.perKmCents[v[0]], c)) + '</span>';
    return row(v[1], m, view(esc(rtKm(c)) + '<i> /km</i>'), rtInput('rt-cost-' + v[0], rtKmPlain(c), '$', '/km', v[1] + ' our cost per km'));
  }).join('');
  var floors = RT_VEHICLES.map(function (v) {
    var c = r.floorCents[v[0]];
    return row(v[1], null, view(esc(rtUsd(c)), rtLkr(c, fx)), rtInput('rt-floor-' + v[0], rtUsdPlain(c), '$', '', v[1] + ' minimum fare'));
  }).join('');
  var day = row('Driver day rate', null, view(esc(rtUsd(r.dayRateCents)) + '<i> /day</i>', rtLkr(r.dayRateCents, fx) + ' /day'),
      rtInput('rt-day', rtUsdPlain(r.dayRateCents), '$', '/day', 'Driver day rate'))
    + row('Our day cost', '<span data-margin-for="day">margin ' + esc(rtMargin(r.dayRateCents, r.dayRateCostCents)) + '</span>',
      view(esc(rtUsd(r.dayRateCostCents)) + '<i> /day</i>'), rtInput('rt-daycost', rtUsdPlain(r.dayRateCostCents), '$', '/day', 'Our driver day cost'));
  var extras = RT_EXTRAS.map(function (x) {
    var c = r.extrasCents[x[0]];
    return row(x[1], null, view(esc(rtUsd(c)), rtLkr(c, fx)), rtInput('rt-x-' + x[0], rtUsdPlain(c), '$', '', x[1]));
  }).join('');
  var bufFx = row('Buffer', 'added to each leg’s distance', view(esc(String(r.bufferPct)) + '%'), rtInput('rt-buffer', String(r.bufferPct), '', '%', 'Buffer percent'))
    + row('FX', 'LKR per USD · display only', view('Rs ' + esc(String(fx)) + ' / $'), rtInput('rt-fx', String(fx), 'Rs', '', 'Rupees per dollar'));
  // Read-only in both modes (owner, 2026-09-26): no booking charges a deposit today.
  var deposit = row('Deposit', 'not charged — bookings are paid in full',
    view(esc(String(d.readOnly.depositPct)) + '%', 'cap ' + rtUsd(d.readOnly.depositCapCents)), null);

  var live = d.live;
  var liveLabel = live.source === 'revision'
    ? 'Live: version <b>' + esc(live.version) + '</b> · saved by ' + esc(rtWho(live.createdBy)) + ' · ' + esc(rtWhen(live.createdAt))
    : 'Live: the code defaults (<b>' + esc(d.defaults.version) + '</b>) — nothing saved yet';
  var actions = !rtCanEdit() ? '' : (edit
    ? '<button class="ch-btn ch-btn-outline ch-btn-sm" data-action="rtCancel">Cancel</button>'
      + '<button class="ch-btn ch-btn-teal ch-btn-sm" data-action="rtReview">Review changes</button>'
    : '<button class="ch-btn ch-btn-teal ch-btn-sm" data-action="rtEdit">Edit rates</button>');
  var note = edit
    ? 'Change any figure, then Review. Prices are what the customer pays; costs only feed the margin. Nothing is live until you save.'
    : 'These are the live prices: a saved change applies to the next quote, website estimate and booking. Approved quotes, and web quotes inside their 7-day lock, keep their prices.';

  return '<div class="ch-rates-top"><div class="ch-rates-live" data-testid="rates-live">' + liveLabel + '</div>'
    + '<div class="ch-rates-actions">' + actions + '</div></div>'
    + '<div class="ch-lock-note">' + note + '</div>'
    + '<div class="ch-rate-grid' + (edit ? ' ch-rt-editing" id="rt-form' : '') + '">'
    + '<div class="ch-rate-col"><div class="ch-rate-group-title">Price per km</div>' + perKm
    + '<div class="ch-rate-group-title">Minimum fare</div>' + floors + '</div>'
    + '<div class="ch-rate-col"><div class="ch-rate-group-title">Our cost per km</div>' + cost
    + '<div class="ch-rate-group-title">Chauffeur day</div>' + day
    + '<div class="ch-rate-group-title">Add-ons</div>' + extras
    + '<div class="ch-rate-group-title">Buffer &amp; FX</div>' + bufFx
    + '<div class="ch-rate-group-title">Deposit</div>' + deposit + '</div>'
    + '</div>';
}

function renderRatesHistory() {
  var d = ratesData;
  if (!d) return '';
  var canRevert = rtCanEdit() && !ratesEditing;
  var rows = d.history.map(function (h, i) {
    var older = d.history[i + 1] ? d.history[i + 1].rates : d.defaults.rates;
    var ch = rtChanges(older, h.rates);
    var chips = ch.length
      ? ch.slice(0, 4).map(function (c) { return '<span class="ch-hist-chip">' + esc(c.label + ' ' + rtShow(c.kind, c.from) + ' → ' + rtShow(c.kind, c.to)) + '</span>'; }).join('')
        + (ch.length > 4 ? '<span class="ch-hist-chip is-quiet">+' + (ch.length - 4) + ' more</span>' : '')
      : '<span class="ch-hist-chip is-quiet">no price change</span>';
    return '<div class="ch-rt-hist-row" data-testid="rates-history-row">'
      + '<span class="ch-hist-rev">' + esc(h.version) + (i === 0 ? ' <span class="ch-badge tone-teal">live</span>' : '') + '</span>'
      + '<span class="ch-hist-meta">' + esc(rtWho(h.createdBy)) + ' · ' + esc(rtWhen(h.createdAt))
      + (h.revertedToVersion ? ' · reverted to ' + esc(h.revertedToVersion) : '') + '</span>'
      + '<span class="ch-hist-chips">' + chips + '</span>'
      + (canRevert && i > 0 ? '<button class="ch-btn ch-btn-ghost ch-btn-sm" data-action="rtRevert" data-version="' + esc(h.version) + '">Revert to this</button>' : '')
      + '</div>';
  });
  rows.push('<div class="ch-rt-hist-row" data-testid="rates-history-defaults">'
    + '<span class="ch-hist-rev">Code defaults' + (d.history.length ? '' : ' <span class="ch-badge tone-teal">live</span>') + '</span>'
    + '<span class="ch-hist-meta">' + esc(d.defaults.version) + ' · rateCard.ts</span>'
    + '<span class="ch-hist-chips"></span>'
    + (canRevert && d.history.length ? '<button class="ch-btn ch-btn-ghost ch-btn-sm" data-action="rtRevert" data-version="' + esc(d.defaults.version) + '">Revert to this</button>' : '')
    + '</div>');
  return '<div class="ch-rt-history"><h3 class="ch-rt-h3">History</h3>' + rows.join('') + '</div>';
}

function renderRatesReview() {
  var rv = ratesReview;
  if (!rv || !ratesData) return '';
  var changes = rv.changes.length
    ? '<table class="ch-rt-table" data-testid="rates-changes"><thead><tr><th>What</th><th>Now</th><th>New</th><th>Change</th></tr></thead><tbody>'
      + rv.changes.map(function (c) {
        var pct = c.pct == null ? '—' : (c.pct > 0 ? '+' : '') + (Math.round(c.pct * 10) / 10) + '%';
        return '<tr' + (c.big ? ' class="is-big"' : '') + '><td>' + esc(c.label) + '</td><td>' + esc(rtShow(c.kind, c.from)) + '</td>'
          + '<td><b>' + esc(rtShow(c.kind, c.to)) + '</b></td><td>' + esc(pct)
          + (c.big ? ' <span class="ch-rt-flag" title="More than 20% either way">check</span>' : '') + '</td></tr>';
      }).join('') + '</tbody></table>'
    : '<div class="ch-hist-empty" data-testid="rates-no-change">Nothing has changed — every figure matches the live rates.</div>';
  var warn = rv.warnings.length
    ? '<div class="ch-rt-warn" data-testid="rates-below-cost">' + rv.warnings.map(esc).join('<br>') + '</div>' : '';
  var samples = rv.samples
    ? '<table class="ch-rt-table" data-testid="rates-samples"><thead><tr><th>Sample trip</th><th>Now</th><th>New</th></tr></thead><tbody>'
      + rv.samples.map(function (s) {
        return '<tr><td>' + esc(s.label) + '</td><td>' + esc(rtUsd(s.currentCents)) + '</td><td><b>' + esc(rtUsd(s.proposedCents)) + '</b></td></tr>';
      }).join('') + '</tbody></table>'
    : '<div class="ch-hist-empty">' + (rv.samplesFailed ? 'Couldn’t price the sample trips — the changes above are still exact.' : 'Pricing sample trips…') + '</div>';
  var revertNote = rv.revertedToVersion
    ? '<div class="ch-lock-note">Reverting to ' + (rv.revertedToVersion === ratesData.defaults.version
      ? 'the code defaults (' + esc(rv.revertedToVersion) + ')' : 'version ' + esc(rv.revertedToVersion))
      + '. History keeps every version: this saves a new one.</div>' : '';
  var err = '';
  if (rv.error && rv.error.kind === 'stale') {
    var cur = rv.error.current;
    err = '<div class="ch-rt-warn" data-testid="rates-stale">Someone saved rates since you opened this page'
      + (cur ? ' — version ' + esc(cur.version) + ' by ' + esc(rtWho(cur.createdBy)) + ', ' + esc(rtWhen(cur.createdAt)) : '')
      + '. Reload to see them, then make your change again.</div>';
  } else if (rv.error && rv.error.kind === 'invalid') {
    err = '<div class="ch-rt-warn">The server refused: ' + esc(rv.error.issues.map(function (i) { return (i.path || []).join('.'); }).join(', ') || 'invalid figures') + '.</div>';
  } else if (rv.error) {
    err = '<div class="ch-rt-warn">Couldn’t save — nothing changed. Try again.</div>';
  }
  var buttons = (rv.error && rv.error.kind === 'stale')
    ? '<button class="ch-btn ch-btn-teal" data-action="rtReload">Reload rates</button>'
    : '<button class="ch-btn ch-btn-outline" data-action="rtReviewClose">' + (rv.revertedToVersion ? 'Cancel' : 'Back to editing') + '</button>'
      + '<button class="ch-btn ch-btn-teal" data-action="rtSave"' + (rv.saving || !rv.changes.length ? ' disabled' : '') + '>'
      + (rv.saving ? 'Saving…' : (rv.revertedToVersion ? 'Revert' : 'Save rates')) + '</button>';
  return '<div class="ch-scrim show" data-action="rtReviewClose"></div>'
    + '<div class="ch-modal" data-testid="rates-review"><div class="ch-modal-card">'
    + '<div class="ch-modal-head"><h2>' + (rv.revertedToVersion ? 'Review the revert' : 'Review rate changes') + '</h2>'
    + '<button class="ch-x-btn" data-action="rtReviewClose" title="Close">&times;</button></div>'
    + '<div class="ch-modal-body">'
    + '<div class="ch-lock-note">Saving makes these the live prices: the next quote, website estimate and booking use them. Approved quotes keep the prices they were approved at.</div>'
    + revertNote + warn + changes
    + '<div class="ch-rate-group-title ch-rt-samples-title">Sample trips</div>' + samples
    + err
    + '<div class="ch-rt-modal-actions">' + buttons + '</div>'
    + '</div></div></div>';
}

// The review dialog renders into its own .qv host on <body>, not inside the page: #view sits at
// z-index 1 under the side rail (z-index 2), so a dialog inside it would be half-covered by the rail
// on a phone however high its own z-index went.
var rtModalRoot = null;
function rtModalHost() {
  if (!rtModalRoot || !rtModalRoot.isConnected) {
    rtModalRoot = document.createElement('div');
    rtModalRoot.className = 'qv qv-page';
    document.body.appendChild(rtModalRoot);
  }
  return rtModalRoot;
}

function renderRatesPage() {
  if (!ratesEl || !ratesEl.isConnected) return;
  var html = '<div class="qv qv-page" data-testid="rates-page">'
    + '<div class="ch-rates-card">'
    + renderRatesEditor()
    + renderRatesHistory()
    + renderHotZonesPanel()
    + '</div>'
    + '</div>';
  // Diff, not innerHTML: a zone list landing mid-typing must not wipe the Add-a-zone field. And the
  // open rates form is the founder's draft — never diff it, or a render mid-edit (a zone list
  // landing, the review opening) would reset a typed figure to its saved value.
  morphdom(ratesEl, '<div>' + html + '</div>', {
    childrenOnly: true,
    onBeforeElUpdated: function (fromEl, toEl) {
      if (ratesEditing && fromEl.id === 'rt-form') return false;
      return !fromEl.isEqualNode(toEl);
    },
  });
  morphdom(rtModalHost(), '<div>' + renderRatesReview() + '</div>', {
    childrenOnly: true,
    onBeforeElUpdated: function (fromEl, toEl) { return !fromEl.isEqualNode(toEl); },
  });
  attachHotZoneAutoComplete();
}

async function loadRates() {
  try {
    var r = await api('/admin/rates');
    var d = r.ok ? await jsonOrNull(r) : null;
    if (!d || !d.live || !d.live.rates || !d.defaults || !Array.isArray(d.history) || !d.readOnly) {
      ratesLoadFailed = true;
    } else {
      ratesData = d;
      ratesLoadFailed = false;
    }
  } catch (e) {
    window.opsReportError && window.opsReportError('rates load', e);
    ratesLoadFailed = true;
  }
  renderRatesPage();
}

// Open the review for a proposed set (a form read, or a revert). The sample trips are priced by the
// server with the real engine; the change list is exact and needs no round trip.
async function rtOpenReview(rates, revertedToVersion) {
  var rv = {
    rates: rates, revertedToVersion: revertedToVersion || null,
    changes: rtChanges(ratesData.live.rates, rates), warnings: rtBelowCost(rates),
    samples: null, samplesFailed: false, saving: false, error: null,
  };
  ratesReview = rv;
  renderRatesPage();
  try {
    var r = await api('/admin/rates/preview', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rates: rates }) });
    var d = r.ok ? await jsonOrNull(r) : null;
    if (ratesReview !== rv) return; // closed or replaced meanwhile
    if (d && Array.isArray(d.samples)) rv.samples = d.samples; else rv.samplesFailed = true;
  } catch (e) {
    if (ratesReview !== rv) return;
    rv.samplesFailed = true;
  }
  renderRatesPage();
}

async function rtSave() {
  var rv = ratesReview;
  if (!rv || rv.saving || !rv.changes.length) return;
  rv.saving = true;
  rv.error = null;
  renderRatesPage();
  try {
    var body = { baseVersion: rtBaseVersion(), rates: rv.rates };
    if (rv.revertedToVersion) body.revertedToVersion = rv.revertedToVersion;
    var r = await api('/admin/rates', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    var d = await jsonOrNull(r);
    if (ratesReview !== rv) return;
    rv.saving = false;
    if (r.status === 201 && d && d.revision) {
      ratesReview = null;
      ratesEditing = false;
      ratesToast('Rates saved — version ' + d.revision.version + ' is live');
      await loadRates();
      apiRateCard().then(function (rc) { if (rc) rateCard = rc; }); // the builder's copy (add-ons, caps) follows
      return;
    }
    if (r.status === 409) rv.error = { kind: 'stale', current: d && d.current };
    else if (r.status === 400) rv.error = { kind: 'invalid', issues: (d && d.issues) || [] };
    else rv.error = { kind: 'failed' };
    renderRatesPage();
  } catch (e) {
    window.opsReportError && window.opsReportError('rates save', e);
    if (ratesReview !== rv) return;
    rv.saving = false;
    rv.error = { kind: 'failed' };
    renderRatesPage();
  }
}

// Mount (or re-mount) into the shell's #rates-mount. A NEW mount node means the founder just
// arrived — fetch the rates and the zones fresh; the same node again is a routine shell repaint.
function showRates(el) {
  var arriving = ratesEl !== el;
  ratesEl = el;
  if (arriving) {
    hzEditId = null;
    ratesEditing = false;
    ratesReview = null;
    ratesData = null;
    ratesLoadFailed = false;
    loadRates();
    loadHotZones();
  }
  renderRatesPage();
}

function hideRates() {
  if (!ratesEl) return;
  ratesEl = null;
  hzEditId = null;
  ratesEditing = false;
  ratesReview = null;
  if (rtModalRoot) rtModalRoot.innerHTML = '';
  hzacClose();
}

// The page lives outside the builder's .ch-app, so its buttons need their own delegate.
document.addEventListener('click', function (e) {
  if (!ratesEl) return;
  var el = e.target.closest('[data-action]');
  if (!el || !(ratesEl.contains(el) || (rtModalRoot && rtModalRoot.contains(el)))) return;
  var action = el.getAttribute('data-action');
  if (action === 'hzSubmit') {
    hzSubmitZone();
  } else if (action === 'hzEditStart') {
    hzEditId = el.getAttribute('data-id');
    renderRatesPage();
  } else if (action === 'hzEditCancel') {
    hzEditId = null;
    renderRatesPage();
  } else if (action === 'hzToggleActive') {
    hzToggleZone(el.getAttribute('data-id'));
  } else if (action === 'hzDelete') {
    hzDeleteZone(el.getAttribute('data-id'));
  } else if (action === 'rtEdit') {
    if (!rtCanEdit() || !ratesData) return;
    ratesEditing = true;
    renderRatesPage();
  } else if (action === 'rtCancel') {
    ratesEditing = false;
    ratesReview = null;
    renderRatesPage();
  } else if (action === 'rtReview') {
    var form = rtReadForm();
    rtShowErrors(form.errors);
    if (!form.rates) { ratesToast('Check the highlighted figures', 'error'); return; }
    rtOpenReview(form.rates, null);
  } else if (action === 'rtReviewClose') {
    ratesReview = null;
    renderRatesPage();
  } else if (action === 'rtSave') {
    rtSave();
  } else if (action === 'rtRevert') {
    if (!rtCanEdit() || !ratesData) return;
    var v = el.getAttribute('data-version');
    var target = v === ratesData.defaults.version ? ratesData.defaults
      : ratesData.history.find(function (h) { return h.version === v; });
    if (target) rtOpenReview(target.rates, v);
  } else if (action === 'rtReload') {
    ratesReview = null;
    ratesEditing = false;
    ratesData = null;
    ratesLoadFailed = false;
    renderRatesPage();
    loadRates();
  }
});

// Margins follow the typed figures as they change — straight onto the page, no render (the open
// form is never re-rendered). Editing a field also clears its error.
document.addEventListener('input', function (e) {
  var t = e.target;
  if (!ratesEl || !ratesEditing || !t || !t.classList || !t.classList.contains('ch-rt-input') || !ratesEl.contains(t)) return;
  t.classList.remove('invalid');
  var err = t.closest('.ch-field') && t.closest('.ch-field').querySelector('.ch-field-err');
  if (err) err.textContent = '';
  var m = /^rt-(km|cost)-(.+)$/.exec(t.id);
  var key = m ? m[2] : ((t.id === 'rt-day' || t.id === 'rt-daycost') ? 'day' : null);
  if (!key) return;
  var places = key === 'day' ? 2 : 4;
  var price = rtCents(rtVal(key === 'day' ? 'rt-day' : 'rt-km-' + key), places);
  var cost = rtCents(rtVal(key === 'day' ? 'rt-daycost' : 'rt-cost-' + key), places);
  var out = ratesEl.querySelector('[data-margin-for="' + key + '"]');
  if (out) out.textContent = 'margin ' + (price != null && cost != null ? rtMargin(price, cost) : '—');
});
```

- [ ] **Step 4: CSS** — replace `.qv .ch-rates-head { display: flex; justify-content: flex-end; margin-bottom: 10px; }` with:

```css
/* Rates editor (spec 2026-09-26 §6–§7): the live-version bar, exact values, the review dialog's
   tables and warnings, and the history rows. Reuses .ch-rate-* rows, .ch-field/.ch-input-wrap
   inputs and .ch-hist-* chips; these rules only add what those don't cover. */
.qv .ch-rates-top { display: flex; align-items: center; justify-content: space-between; gap: 10px; flex-wrap: wrap; margin-bottom: 10px; }
.qv .ch-rates-live { font-size: 12.5px; color: var(--muted); min-width: 0; }
.qv .ch-rates-live b { color: var(--ink); }
.qv .ch-rates-actions { display: flex; gap: 8px; flex-wrap: wrap; }
.qv .ch-rt-val { display: inline-flex; flex-direction: column; align-items: flex-end; font-size: 13px; font-weight: 600; color: var(--ink); }
.qv .ch-rt-val i { font-style: normal; font-weight: 400; color: var(--muted); font-size: 11.5px; }
.qv .ch-rt-val small { font-size: 11px; font-weight: 500; color: var(--muted-2); }
.qv .ch-rt-editing .ch-rate-row { align-items: flex-start; }
.qv .ch-rt-editing .ch-rate-label { padding-top: 9px; }
.qv .ch-rt-h3 { margin: 18px 0 6px; font-size: 15px; }
.qv .ch-rt-hist-row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; padding: 8px 0; border-top: 1px solid var(--line); font-size: 12px; }
.qv .ch-rt-hist-row .ch-hist-chips { flex: 1 1 240px; justify-content: flex-start; min-width: 0; }
.qv .ch-rt-hist-row .ch-hist-chip { white-space: normal; }
/* The builder's history meta truncates to one line; here who and when must read in full. */
.qv .ch-rt-hist-row .ch-hist-meta { flex: 0 1 auto; white-space: normal; overflow: visible; }
.qv .ch-rt-hist-row .ch-hist-rev { color: var(--ink); font-weight: 700; }
.qv .ch-rt-table { width: 100%; border-collapse: collapse; font-size: 12.5px; margin: 6px 0 4px; }
.qv .ch-rt-table th { text-align: left; font-size: 10.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .5px; color: var(--muted-2); padding: 4px 6px; border-bottom: 1px solid var(--line); }
.qv .ch-rt-table td { padding: 6px; border-bottom: 1px dashed var(--line); vertical-align: top; }
.qv .ch-rt-table td:not(:first-child), .qv .ch-rt-table th:not(:first-child) { text-align: right; white-space: nowrap; }
.qv .ch-rt-table tr.is-big td { background: rgba(236,58,36,.05); }
.qv .ch-rt-flag { display: inline-block; font-size: 10px; font-weight: 700; color: #8a5a00; background: #fdf0d2; border: 1px solid #f0d9a6; border-radius: 999px; padding: 0 6px; }
.qv .ch-rt-warn { margin: 10px 0; padding: 10px 12px; border-radius: var(--r-md); background: #fdf0d2; color: #6b4600; font-size: 12.5px; border: 1px solid #f0d9a6; line-height: 1.45; }
.qv .ch-rt-samples-title { margin-top: 14px; }
.qv .ch-rt-modal-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 16px; flex-wrap: wrap; }
:root[data-theme="dark"] .qv .ch-rt-flag,
:root[data-theme="dark"] .qv .ch-rt-warn { color: #f5c96a; background: rgba(245,201,106,.12); border-color: rgba(245,201,106,.35); }
```

- [ ] **Step 5: Run and watch it pass**

Run: `cd web-tests && npx playwright test ops-rates-edit ops-rates-page ops-hotzone-autocomplete quote-approval --workers=2; echo "exit=$?"`
Expected: all pass, `exit=0`. The hot-zone spec's catch-all `{}` for `/admin/rates` now reads as
"Couldn't load the rates", and the zones panel still renders.

- [ ] **Step 6: Look at it.** Take screenshots with a throwaway spec: the view, the edit form, the
review dialog, and history with revert, at 1280px and 375px. Check the placeholders, the flags and
the modal fit.

**As executed (2026-09-26):** the visual check found three things, each fixed and re-checked:
1. **Value and unit stacked.** In the read view the `/km` unit sat on its own line, because
   `.ch-rt-val` is a column and every child stacked. The value and unit are now grouped in one span.
2. **Dialog covered at phone width.** The side rail covered the review dialog's left edge at 375px:
   `#view` has z-index 1 and sits under `.rail` (z-index 2), so no z-index inside it can escape. The
   dialog now renders into its own `.qv` host on `<body>` (`rtModalHost()`). A regression test,
   "sits above the side rail", failed with the old placement and passes now.
3. **History meta truncated.** The rows inherited the builder's one-line `.ch-hist-meta` truncation.
   It is overridden for `.ch-rt-hist-row`.

- [ ] **Step 7: Commit** `api/src/routes/ops-ui.html` and the two specs, with the message
`feat(ops): the founder edits rates on the Rates page — review, save, history, revert`. The message
gets the attribution trailer.

---

### Task 2: Ship

- [ ] Merge `origin/main` if it moved, including PR 3 once merged. Run the full gates:
  `cd api && npm run check` (with `DATABASE_URL_TEST`) and `cd web-tests && npm run test:all`.
- [ ] Push `feat/ops-rates-edit`, open the PR (evidence, screenshots, release note), bind it and
  read CI. Merge on the owner's say-so.
- [ ] Release note:
  - **Staging:** the ops UI reaches staging on merge, and the founder can then try a save there.
    Staging's database is separate from prod's.
  - **Prod:** prod gets it on the promote that also carries 0057. That promote needs the owner's
    explicit OK for the migration.
  - **First prod edit:** only after PRs 2–4 are all promoted (spec §11).
