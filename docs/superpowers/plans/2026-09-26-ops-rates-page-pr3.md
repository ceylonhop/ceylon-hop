# Ops Rates page — PR 3 (the site loads live prices) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every page that prices from the site's baked copy (`transfers-data.js`) swaps in the live
price list from `GET /quote/pricing` (PR 2) on load. The pages that draw a copy price on first
paint are plan, home and why. They hold those figures until the list lands, so a customer never
sees a price change in front of them. The baked numbers stay as the fallback.

**Architecture:**
- **Loader.** `transfers-data.js` gets a small loader after its `window.TRANSFERS` export. If
  `window.CEYLON_HOP_API` is set, it fetches `/quote/pricing` with a 2.5 s cap, validates the whole
  list, and writes it into the copy. Objects are updated in place (`PER_KM`, `FLOORS`, `EXTRAS`,
  `SEAT_PRICING`). The two editable scalars (`BUFFER_PCT`, `CHAUFFEUR_DAY_FEE`) are reassigned,
  which needs `let` from the generator, and mirrored onto `window.TRANSFERS`. It then fires
  `ch:pricing` and settles `TRANSFERS.pricingReady`. A late answer after the cap is dropped.
- **Head snippet.** The three holding pages get the same head line `search.html`/`booking.html`
  already have, which sets the API base and honours `?api=off`. It also adds `prices-pending` to
  `<html>` before first paint, with a backstop timer, mirroring the route pages' `fares-pending`.
- **Redraw.** Each page marks its price figures with `data-live-price` and redraws on
  `ch:pricing`.

**Tech Stack:** static site (vanilla JS, GitHub Pages from `production`), generators in
`tools/*.mjs`, Vitest/jsdom unit tests and Playwright e2e in `web-tests/`.

**Spec:** `docs/superpowers/specs/2026-09-26-ops-rates-page-design.md` §9, §10 (PR 3).

## Global Constraints

- The baked block stays generated from the **code** card (`npm run generate` → `dump:pricing` →
  `buildPricingPayload()`). Never hand-edit it. CI regenerates and fails on any drift, so run the
  full `npm run generate` (which includes the `?v=` stamps) and commit everything it changes.
- The loader applies only what the founder can change, plus the seat pricing derived from it:
  `perKm`, `floors`, `bufferPct`, `chauffeurDayFee`, `extras`, `seatPricing`. Everything else in the
  list is code-only and identical to the baked copy.
- The list is all-or-nothing: if any of those numbers is missing, not finite, or ≤ 0 (buffer may be
  0), nothing is applied.
- Only pages that set `window.CEYLON_HOP_API` fetch. Today those are search, booking and board;
  after this PR plan, home and why join them. tours/tour load the copy but show no copy prices.
- Offline e2e is safe as it stands. `serve-booking.js` rewrites every live-API fetch to its own
  origin, so `/quote/pricing` gets a 404 and pages keep the baked numbers. Specs that want live
  prices stub `**/quote/pricing`.
- `booking.js` and `search.js` price from the engine first; the copy is only their fallback. They
  get the loader for free and **no** new hold.
- Tests go red then green; run `cd web-tests && npm run test:all` and `cd api && npm run check`
  with the real exit code. This PR ships on the next promote: Pages serves `production`.
- Work in the worktree
  `/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad/wt-rates3`,
  branch `feat/site-live-prices`.

---

### Task 1: The loader in `transfers-data.js`, plus `let` bindings from the generator

**Files:**
- Modify: `tools/generate-pricing.mjs:22-39` (`renderPricingBlock`)
- Modify: `transfers-data.js` (the regenerated block, and the loader after `window.TRANSFERS = {…};`)
- Test: `web-tests/unit/live-pricing.test.js` (new), `web-tests/unit/pricing-codegen.test.js` (one case)

**Interfaces — Produces:**
- `window.TRANSFERS.pricingReady: Promise<boolean>`, which is true when the live list was applied.
- `window.TRANSFERS.applyLivePricing(list): boolean`, for tests.
- The DOM event `ch:pricing` on `document`, fired only when a list was applied.
- On settle it removes the `prices-pending` class from `<html>`.

- [ ] **Step 1: Write the failing tests**

Add to `web-tests/unit/pricing-codegen.test.js`, inside the `describe('injectPricingBlock', …)`
block:

```js
  it('emits reassignable bindings for the two live scalars (the loader swaps them — spec 2026-09-26 §9)', () => {
    const block = renderPricingBlock({ ...payload, seatPricing: { perKmCentsVan: 54.05, floorCentsVan: 4999, seatsCoveringVan: 3 }, sharedProducts: [] });
    expect(block).toContain('let BUFFER_PCT = 10;');
    expect(block).toContain('let CHAUFFEUR_DAY_FEE = 35;');
    expect(block).toContain('const PER_KM = ');
    expect(block).not.toMatch(/let (PER_KM|FLOORS|EXTRAS|SEAT_PRICING)\b/);
  });
```

Create `web-tests/unit/live-pricing.test.js`:

```js
// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { loadTransfers } from './_load.js';

// The site's live price list (spec 2026-09-26 §9): transfers-data.js swaps GET /quote/pricing into
// its baked copy on load, all-or-nothing, within a 2.5 s cap.
const LIVE = {
  perKm: { car: 0.8, van: 1.1 }, floors: { car: 35, van: 60 }, bufferPct: 12,
  priceFinishing: { maxReductionBps: 250, roundToCents: 50 }, chauffeurDayFee: 40,
  chauffeurIdleMinKm: { car: 50, van: 100 }, depositPct: 0.1, depositCap: 50,
  extras: { sightseeing: 11, 'safari-wait': 20, luggage: 6, front: 9, flex: 13, waiting: 12 },
  corridorSeat: {}, seatPricing: { perKmCentsVan: 110, floorCentsVan: 6000, seatsCoveringVan: 3 }, sharedProducts: [],
};
const okFetch = (body) => vi.fn(async () => ({ ok: true, json: async () => body }));

let events;
const onPricing = () => events++;
beforeEach(() => {
  events = 0;
  document.addEventListener('ch:pricing', onPricing);
  document.documentElement.classList.add('prices-pending'); // what the page head does
});
afterEach(() => {
  document.removeEventListener('ch:pricing', onPricing);
  delete window.CEYLON_HOP_API;
  delete window.fetch;
  vi.useRealTimers();
});

describe('live price list', () => {
  it('applies a valid list: helpers price on it, the scalars are mirrored, ch:pricing fires, the hold lifts', async () => {
    window.CEYLON_HOP_API = 'https://api.test';
    window.fetch = okFetch(LIVE);
    const T = loadTransfers();
    const baked = { car: T.PER_KM.car, fee: T.CHAUFFEUR_DAY_FEE };
    expect(await T.pricingReady).toBe(true);
    expect(window.fetch).toHaveBeenCalledWith('https://api.test/quote/pricing', expect.objectContaining({ credentials: 'omit' }));
    expect(T.PER_KM).toEqual({ car: 0.8, van: 1.1 });
    expect(T.FLOORS).toEqual({ car: 35, van: 60 });
    expect(T.BUFFER_PCT).toBe(12);
    expect(T.CHAUFFEUR_DAY_FEE).toBe(40);
    expect(T.EXTRAS.waiting).toBe(12);
    expect(T.billableKm(100)).toBe(112); // the lexical BUFFER_PCT moved too, not just the export
    expect(baked).toEqual({ car: 0.4025, fee: 31.05 });
    expect(events).toBe(1);
    expect(document.documentElement.classList.contains('prices-pending')).toBe(false);
  });

  it.each([
    ['a network failure', vi.fn(async () => { throw new Error('offline'); })],
    ['a 404 (the API has no /quote/pricing yet)', vi.fn(async () => ({ ok: false, json: async () => ({}) }))],
    ['a malformed list', okFetch({ ...LIVE, perKm: { car: -1, van: 1.1 } })],
    ['a list missing an add-on', okFetch({ ...LIVE, extras: { waiting: 12 } })],
  ])('keeps every baked number on %s, and still lifts the hold', async (_label, fetchImpl) => {
    window.CEYLON_HOP_API = 'https://api.test';
    window.fetch = fetchImpl;
    const T = loadTransfers();
    expect(await T.pricingReady).toBe(false);
    expect(T.PER_KM).toEqual({ car: 0.4025, van: 0.5405 });
    expect(T.BUFFER_PCT).toBe(10);
    expect(T.EXTRAS.waiting).toBe(10);
    expect(events).toBe(0);
    expect(document.documentElement.classList.contains('prices-pending')).toBe(false);
  });

  it('gives up at 2.5 s and drops a late answer — a figure once shown never changes', async () => {
    vi.useFakeTimers();
    window.CEYLON_HOP_API = 'https://api.test';
    let answer;
    window.fetch = vi.fn(() => new Promise((res) => { answer = res; }));
    const T = loadTransfers();
    vi.advanceTimersByTime(2500);
    expect(await T.pricingReady).toBe(false);
    answer({ ok: true, json: async () => LIVE });
    await vi.runAllTimersAsync();
    expect(T.PER_KM.car).toBe(0.4025);
    expect(events).toBe(0);
  });

  it('does not fetch at all when the page has no API base (?api=off, or a page that shows no copy prices)', async () => {
    window.fetch = vi.fn();
    window.CEYLON_HOP_API = '';
    const T = loadTransfers();
    expect(await T.pricingReady).toBe(false);
    expect(window.fetch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `cd web-tests && npx vitest run unit/live-pricing.test.js unit/pricing-codegen.test.js; echo "exit=$?"`
Expected: FAIL. `T.pricingReady` is undefined, and the block renders `const BUFFER_PCT`. Exit ≠ 0.

- [ ] **Step 3: The generator** — in `renderPricingBlock`, change two lines:

```js
    // `let`, not `const`: transfers-data.js swaps these two for the live list on load (spec
    // 2026-09-26 §9). The objects stay const — the loader updates them in place.
    `let BUFFER_PCT = ${p.bufferPct};`,
```

and

```js
    `let CHAUFFEUR_DAY_FEE = ${p.chauffeurDayFee};`,
```

- [ ] **Step 4: The loader** — in `transfers-data.js`, directly after the closing `};` of
`window.TRANSFERS = { … };` and before the IIFE's closing `})();`, add:

```js
  /* ── Live price list (spec docs/superpowers/specs/2026-09-26-ops-rates-page-design.md §9) ──
     The numbers at the top are baked in at build time from the code rate card. The founder can now
     change prices on the ops Rates page, so on load this asks the API for the live list
     (GET /quote/pricing — the same payload shape) and writes it into the copy: objects in place,
     the two scalars reassigned and mirrored onto window.TRANSFERS. All-or-nothing: a missing, non-
     finite or non-positive number keeps every baked value. Pages that draw a copy price on first
     paint hide it behind html.prices-pending (their <head> adds it) and redraw on `ch:pricing`, so a
     customer never sees one number turn into another. A slow answer (2.5 s) is dropped: once the
     baked figures have been shown they stay. Only pages that set window.CEYLON_HOP_API fetch. */
  const LIVE_CAP_MS = 2500;
  const T = window.TRANSFERS;
  const positive = (n) => typeof n === 'number' && isFinite(n) && n > 0;
  function applyLivePricing(p) {
    const ok = !!p && !!p.perKm && positive(p.perKm.car) && positive(p.perKm.van)
      && !!p.floors && positive(p.floors.car) && positive(p.floors.van)
      && typeof p.bufferPct === 'number' && isFinite(p.bufferPct) && p.bufferPct >= 0
      && positive(p.chauffeurDayFee)
      && !!p.extras && Object.keys(EXTRAS).every((k) => positive(p.extras[k]))
      && !!p.seatPricing && positive(p.seatPricing.perKmCentsVan) && positive(p.seatPricing.floorCentsVan);
    if (!ok) return false;
    PER_KM.car = p.perKm.car; PER_KM.van = p.perKm.van;
    FLOORS.car = p.floors.car; FLOORS.van = p.floors.van;
    Object.keys(EXTRAS).forEach((k) => { EXTRAS[k] = p.extras[k]; });
    SEAT_PRICING.perKmCentsVan = p.seatPricing.perKmCentsVan;
    SEAT_PRICING.floorCentsVan = p.seatPricing.floorCentsVan;
    BUFFER_PCT = p.bufferPct; T.BUFFER_PCT = p.bufferPct;
    CHAUFFEUR_DAY_FEE = p.chauffeurDayFee; T.CHAUFFEUR_DAY_FEE = p.chauffeurDayFee;
    return true;
  }
  T.applyLivePricing = applyLivePricing;
  T.pricingReady = new Promise((resolve) => {
    let settled = false;
    const settle = (live) => {
      if (settled) return;
      settled = true;
      try { document.documentElement.classList.remove('prices-pending'); } catch (e) { /* no DOM */ }
      if (live) { try { document.dispatchEvent(new CustomEvent('ch:pricing')); } catch (e) { /* no DOM */ } }
      resolve(live);
    };
    const base = (typeof window.CEYLON_HOP_API === 'string') ? window.CEYLON_HOP_API.replace(/\/$/, '') : '';
    if (!base || typeof window.fetch !== 'function') { settle(false); return; }
    setTimeout(() => settle(false), LIVE_CAP_MS);
    window.fetch(base + '/quote/pricing', { credentials: 'omit' })
      .then((r) => (r && r.ok ? r.json() : null))
      .then((p) => { if (!settled) settle(applyLivePricing(p)); })
      .catch(() => settle(false));
  });
```

Check that `billableKm` is exported on `window.TRANSFERS`; the test uses `T.billableKm`. It is, in
the export list at `:486`. The helpers read `PER_KM`, `FLOORS` and `BUFFER_PCT` lexically, so they
price on the live values without any change to them.

- [ ] **Step 5: Regenerate** — the block now uses `let`, and CI diffs every generated file:

Run: `cd api && npm ci --no-audit --no-fund --loglevel=error` (first time in this worktree), then
`cd .. && npm run generate; echo "exit=$?"`, then `git status --short`.
Expected: exit 0. The changed files are `transfers-data.js` (the two `let` lines) plus the
`?v=` stamps on pages that load `transfers-data.js`. Run `git diff --stat` and confirm nothing else
moved.

- [ ] **Step 6: Run and watch it pass**

Run: `cd web-tests && npx vitest run unit/live-pricing.test.js unit/pricing-codegen.test.js unit/pricing.test.js unit/backend-price-parity.test.js; echo "exit=$?"`
Expected: pass, `exit=0`.

- [ ] **Step 7: Commit** — `tools/generate-pricing.mjs`, `transfers-data.js`, the two test files,
and every file the generator re-stamped. Message:
`feat(site): transfers-data.js loads the live price list (GET /quote/pricing) on page load`.
The message gets the attribution trailer.

---

### Task 2: Plan, home and why hold their prices, then redraw on `ch:pricing`

**Files:**
- Modify: `site.css` (hold rule), `plan.html` (head snippet, `#sum-amt`), `plan.js` (`.lm-price b`, listener), `index.html` (head snippet, popular-transfers render), `why.html` (head snippet, `#cmp-car`/`#cmp-taxi`, comparison render)
- Test: `web-tests/e2e/live-pricing.spec.js` (new)

**Interfaces — Consumes:** `TRANSFERS.pricingReady`, the `ch:pricing` event and the
`prices-pending` class (Task 1).

- [ ] **Step 1: Write the failing e2e spec** — `web-tests/e2e/live-pricing.spec.js`:

```js
import { test, expect } from '@playwright/test';

// Spec 2026-09-26 §9: plan, home and why draw copy prices on first paint. With the live list
// available they show ITS numbers — never the baked ones first — and with it blocked they show the
// baked ones after the hold. /quote/pricing reaches the static server in offline e2e (see
// serve-booking.js), so every case stubs it explicitly.
const json = (o) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(o) });
const BAKED_CAR = 0.4025;
const LIVE = {
  perKm: { car: 1.2, van: 1.5 }, floors: { car: 29, van: 49.99 }, bufferPct: 10,
  priceFinishing: { maxReductionBps: 250, roundToCents: 50 }, chauffeurDayFee: 31.05,
  chauffeurIdleMinKm: { car: 50, van: 100 }, depositPct: 0.1, depositCap: 50,
  extras: { sightseeing: 10, 'safari-wait': 19, luggage: 5, front: 8, flex: 12, waiting: 10 },
  corridorSeat: {}, seatPricing: { perKmCentsVan: 150, floorCentsVan: 4999, seatsCoveringVan: 3 }, sharedProducts: [],
};

async function live(page, { delayMs = 0, status = 200 } = {}) {
  await page.route('**/quote/pricing', async (r) => {
    if (delayMs) await new Promise((res) => setTimeout(res, delayMs));
    return status === 200 ? r.fulfill(json(LIVE)) : r.fulfill({ status, body: '' });
  });
}
const num = (s) => Number(String(s).replace(/[^0-9.]/g, ''));

test('home: popular transfers show the live price, and are held (not baked) while it loads', async ({ page }) => {
  await live(page, { delayMs: 1200 });
  await page.goto('/index.html');
  const fig = page.locator('#home-transfers .tc-price b').first();
  await expect(page.locator('html')).toHaveClass(/prices-pending/);
  expect(await fig.evaluate((el) => getComputedStyle(el).color)).toBe('rgba(0, 0, 0, 0)');
  await expect(page.locator('html')).not.toHaveClass(/prices-pending/, { timeout: 5000 });
  const shown = num(await fig.textContent());
  const expected = await page.evaluate(() => window.TRANSFERS.privateQuote('cmb-airport', 'kandy').car);
  expect(shown).toBe(expected);
  expect(await page.evaluate(() => window.TRANSFERS.PER_KM.car)).toBe(1.2);
});

test('home: with the list unavailable the baked price shows once the hold lifts', async ({ page }) => {
  await live(page, { status: 404 });
  await page.goto('/index.html');
  await expect(page.locator('html')).not.toHaveClass(/prices-pending/, { timeout: 5000 });
  expect(await page.evaluate(() => window.TRANSFERS.PER_KM.car)).toBe(BAKED_CAR);
  await expect(page.locator('#home-transfers .tc-price b').first()).toHaveCSS('color', /rgb\((?!0, 0, 0\))/);
});

test('why: the comparison shows the live car price', async ({ page }) => {
  await live(page);
  await page.goto('/why.html');
  await expect(page.locator('html')).not.toHaveClass(/prices-pending/, { timeout: 5000 });
  const expected = await page.evaluate(() => window.TRANSFERS.privateQuote('cmb-airport', 'kandy').car);
  await expect(page.locator('#cmp-car')).toHaveText(`$${expected} fixed`);
});

test('plan: a restored itinerary prices its leg and summary on the live list', async ({ page }) => {
  await live(page, { delayMs: 800 });
  await page.goto('/plan.html?stops=' + encodeURIComponent('Colombo Airport (CMB)|Kandy'));
  await expect(page.locator('html')).not.toHaveClass(/prices-pending/, { timeout: 5000 });
  await expect(page.locator('.lm-price b').first()).toBeVisible();
  const leg = num(await page.locator('.lm-price b').first().textContent());
  const expected = await page.evaluate(() => {
    const T = window.TRANSFERS;
    const km = T.kmBetween('Colombo Airport (CMB)', 'Kandy');
    return T.finishPrice(T.legPrice(km, 'car'), T.FLOORS.car);
  });
  expect(leg).toBe(Math.round(expected * 100) / 100);
  await expect(page.locator('#sum-amt')).not.toHaveText('~$—');
});
```

Before relying on the plan case, check how `plan.js` behaves at `?stops=A|B`: that it builds
one transfer leg and renders `.lm-price` for a catalogue pair without a Google call, and that the
`vehicle` default is `car`. Check it with a quick local run of the page (`node serve-booking.js`,
then open the URL in the browser pane), then adjust the stop names or the assertion to what the
page really renders. Do **not** change `plan.js` to fit the test. If `money()` rounding makes the
leg figure a whole dollar, compare after the same rounding (`money()` prints 0 decimals for whole
dollars).

- [ ] **Step 2: Run it and watch it fail**

Run: `cd web-tests && npx playwright test live-pricing --workers=2; echo "exit=$?"`
Expected: FAIL. The pages never add `prices-pending` and never fetch, because they don't set
`CEYLON_HOP_API`. Exit ≠ 0.

- [ ] **Step 3: The hold rule** — append to `site.css`:

```css
/* Live price list (spec 2026-09-26 §9): a page's <head> adds html.prices-pending when it will fetch
   the live list, and transfers-data.js lifts it when the list lands or 2.5 s passes. Held figures
   keep their space and read as a placeholder, so the first price a customer sees is the current
   one — the same treatment the route pages give [data-fare] (fares-pending). */
.prices-pending [data-live-price]{color:transparent!important;background:var(--cream-deep,#ece6da);border-radius:6px}
```

- [ ] **Step 4: The head snippet** — in `plan.html`, `index.html` and `why.html`, directly after
`<link rel="stylesheet" href="site.css?v=…">`, add:

```html
<!-- Live prices (spec 2026-09-26 §9): transfers-data.js loads the founder's current price list from
     the API; `?api=off` keeps the baked prices, `?api=<origin>` points it elsewhere (the same
     contract as search.html / booking.html). The hold keeps [data-live-price] figures blank until
     that list lands; transfers-data.js lifts it, and the timer is only the backstop. -->
<script>(function(){var p=new URLSearchParams(location.search).get('api');window.CEYLON_HOP_API=(p==='off')?'':(p||window.CEYLON_HOP_API||'https://ceylon-hop-api.onrender.com');if(window.CEYLON_HOP_API){var d=document.documentElement;d.classList.add('prices-pending');setTimeout(function(){d.classList.remove('prices-pending');},3000);}})();</script>
```

- [ ] **Step 5: Mark and redraw**

In `plan.js`, in the leg-meta template, change `<b>${money(T.finishPrice(price, minLegPrice(state.vehicle)))}</b>`
to `<b data-live-price>${money(T.finishPrice(price, minLegPrice(state.vehicle)))}</b>`. At the end
of the file, after the final `render();`, add:

```js
// The live price list landed (transfers-data.js, spec 2026-09-26 §9): every figure above was drawn
// from the baked copy while html.prices-pending hid it — draw them again from the live one.
document.addEventListener('ch:pricing', () => render());
```

In `plan.html`, add `data-live-price` to the element with `id="sum-amt"`.

In `index.html`:
- Change `<span class="tc-price">from <b>$${displayPrice(q.car)}</b> fixed</span>` to
  `<span class="tc-price">from <b data-live-price>$${displayPrice(q.car)}</b> fixed</span>`.
- Wrap the `document.getElementById('home-transfers').innerHTML = POP_TRANSFERS.map(…).join('');`
  statement in `function renderPopularTransfers(){ … }`, call it once where the statement was,
  then add:

```js
  // Redraw from the live price list once it lands (transfers-data.js, spec 2026-09-26 §9).
  document.addEventListener('ch:pricing', renderPopularTransfers);
```

  If the `.reveal` class animates cards in on scroll, check a redraw doesn't hide them again. The
  site's reveal observer may only watch the first set of nodes. If it does, re-run the page's
  reveal hook after the redraw, or keep the redraw to the price text (update each
  `.tc-price b[data-live-price]` in place by index). Prefer the in-place update if the reveal
  observer is involved.

In `why.html`:
- Add `data-live-price` to the elements `id="cmp-car"` and `id="cmp-taxi"` in the markup.
- Turn the comparison IIFE into a named function `function drawComparison(){ … }`, call it once,
  then add `document.addEventListener('ch:pricing', drawComparison);`.
- Inside it, the `cmp-seat` branch calls `seatEl.remove()` when there's no shared option; a second
  call finds no element, which is already handled by `if(seatEl)`. Leave that as it is.

- [ ] **Step 6: Regenerate stamps, run and watch it pass**

Run from the repo root: `npm run generate; echo "exit=$?"`. This re-stamps `?v=` on pages that
load `site.css` and `plan.js`.

Run: `cd web-tests && npx playwright test live-pricing home plan why --workers=2; echo "exit=$?"`
Expected: pass, `exit=0`.

Run: `cd web-tests && npx vitest run unit/why-fallback-prices.test.js unit/home-transfer-links.test.js; echo "exit=$?"`
Expected: pass. The no-JS fallback markup is unchanged.

- [ ] **Step 7: Look at it** — use the `browser_batch` browser-pane tools to capture home, why and
plan at desktop and 375px:
- with the list stubbed slow: the hold shows placeholders
- with the list stubbed live: the live figures show

Use a throwaway Playwright spec in the scratchpad, as in PR 1. Check that the placeholders don't
shift the layout.

- [ ] **Step 8: Commit** — every changed file plus the re-stamped pages. Message:
`feat(site): plan, home and why hold their prices until the live list lands`. The message gets the
attribution trailer.

---

### Task 3: Ship

- [ ] Merge `origin/main` if it moved, including PR 2 once merged. Then run the full gates:
  `cd api && npm run check` (with `DATABASE_URL_TEST`) and `cd web-tests && npm run test:all`.
  Read the real exit codes.
- [ ] Push `feat/site-live-prices` and open the PR. The body covers:
  - the red→green evidence
  - the hold and fallback behaviour
  - **release:** it reaches customers only on the `main → production` promote, because Pages serves
    `production`, and the live list only differs once PR 2 is on prod and a revision is saved
  - a note that `booking.js` and `search.js` are unchanged and get the loader for free
  It ends with the attribution line.
- [ ] Bind the PR and read its CI. Ask the owner before merging or enabling auto-merge. They
  approved merge-when-green for PR 1 and PR 2 explicitly, not for the series.
