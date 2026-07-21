# Ops route-choice modal — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the shipped on-demand "Compare routes" link into a dismissible modal that auto-opens only when a leg has a materially different route, with both routes on a map and an honest two-option comparison.

**Architecture:** Front-end-heavy change to the single served file `api/src/routes/ops-ui.html`. The backend already returns `variants` only when a toll-free route is materially slower (`maps.ts` → `hasChoice`); we raise that bar to 45 min, fetch variants proactively when a leg resolves, and auto-open a modal (guarded so it never nags). Picking reuses the existing `routeVariant`/`routeOptions` persistence and note-string contract from Phase 1. The modal map reuses the itinerary map's `computeRoutes`/`createPolylines` path, drawing two routes.

**Tech Stack:** Vanilla JS in `ops-ui.html` (no framework), Hono/TS backend (`api/`), Google Maps JS Routes API, Vitest (unit), Playwright (e2e).

## Global Constraints

- **Maintenance mode:** one logical change per commit; stage only files by path (never `git add -A`); leave green.
- **Green gate before every commit:** `cd api && npm run check` **and** `npm run test:all` (web-tests) must pass.
- **TDD for logic:** write the failing test first, see it fail, implement, see it pass. Pure copy/CSS/visual steps verify in the browser preview instead (no test required).
- **Backend code stays in `api/`.** The threshold constant lives in `api/src/adapters/maps.ts`.
- **Reuse, don't re-derive:** `routeVariant` values are exactly `'fastest'` | `'no_tolls'`. The customer note is produced by `routeText(leg)` and is **copy-gated** — do not change its strings (`(via expressway)` / `(via local road, no highway tolls)`); `web-tests/unit/ops-route-note.test.js` pins them.
- **Route colors:** expressway `#2F6FE0` (blue, solid), local road `#BA7517` (amber, dashed). Do **not** use the brand teal (`#0AB9B6` / `#1D9E75`) for route categories.
- **Scope:** ops quote tool only. No customer-booker changes. No pricing/schema/config changes.
- **Rollout:** merging to `main` auto-deploys to **staging**; prod is a separate `main → production` promotion. This plan targets `main` (→ staging soak) only.

---

## File structure

- `api/src/adapters/maps.ts` — the `CHOICE_MIN_TIME_SAVED_MIN` threshold (30 → 45).
- `api/src/adapters/maps.test.ts` — boundary test for the new threshold.
- `api/src/routes/ops-ui.html` — all client work: a pure `shouldPromptRouteChoice`, the modal (state + markup + handlers), the two-route map, the proactive fetch/auto-open, and the pills→chip swap.
- `web-tests/unit/ops-route-choice-trigger.test.js` — **new**, unit-tests the pure trigger function via the extract-and-eval pattern.
- `web-tests/e2e/ops-quote-route-choice.spec.js` — extend the existing e2e for the modal flow.

---

## Task 1: Raise the fork threshold to 45 minutes

**Files:**
- Modify: `api/src/adapters/maps.ts:17` (`CHOICE_MIN_TIME_SAVED_MIN`)
- Test: `api/src/adapters/maps.test.ts` (add a boundary case near line 362)

**Interfaces:**
- Consumes: nothing.
- Produces: no signature change. `distanceVariants()` still returns `{ fastest, noTolls, hasChoice }`; only the `hasChoice` cutoff moves from `>= 30` to `>= 45` minutes slower.

- [ ] **Step 1: Write the failing boundary test**

Add inside the `GoogleMapsAdapter.distanceVariants` describe block in `api/src/adapters/maps.test.ts` (after the test ending at line 362):

```ts
it('a 40-minute-slower toll-free route is NOT a choice (below the 45-min bar)', async () => {
  global.fetch = (async (url: string) => {
    if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 370); // 370 - 330 = 40
    return distanceMatrixResponse(292, 330);
  }) as typeof fetch;
  const adapter = new GoogleMapsAdapter('test-key');
  const r = await adapter.distanceVariants('Colombo City', 'Ella');
  expect(r?.hasChoice).toBe(false);
  expect(r?.noTolls).toBeNull();
});

it('a 60-minute-slower toll-free route IS a choice (at/above the 45-min bar)', async () => {
  global.fetch = (async (url: string) => {
    if (String(url).includes('avoid=tolls')) return distanceMatrixResponse(205, 390); // 390 - 330 = 60
    return distanceMatrixResponse(292, 330);
  }) as typeof fetch;
  const adapter = new GoogleMapsAdapter('test-key');
  const r = await adapter.distanceVariants('Colombo City', 'Ella');
  expect(r?.hasChoice).toBe(true);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd api && npx vitest run src/adapters/maps.test.ts -t "40-minute-slower"`
Expected: FAIL — with the current `>= 30` threshold, a 40-min gap yields `hasChoice: true`, so `expect(false)` fails.

- [ ] **Step 3: Raise the constant**

In `api/src/adapters/maps.ts:17`:

```ts
export const CHOICE_MIN_TIME_SAVED_MIN = 45;
```

- [ ] **Step 4: Run the maps tests to verify green**

Run: `cd api && npx vitest run src/adapters/maps.test.ts`
Expected: PASS (both new cases; the existing 60-min and Fake-pair cases stay green — their gaps are ≥ 45).

- [ ] **Step 5: Commit**

```bash
git add api/src/adapters/maps.ts api/src/adapters/maps.test.ts
git commit -m "feat(maps): raise route-fork threshold to 45 min slower"
```

---

## Task 2: Pure `shouldPromptRouteChoice` decision function

A self-contained, DOM-free function that encodes the auto-open guardrails so they are unit-testable (same extract-and-eval trick as `routeText`).

**Files:**
- Modify: `api/src/routes/ops-ui.html` (add the function next to `compareRoutes`, ~line 4972)
- Test: `web-tests/unit/ops-route-choice-trigger.test.js` (**new**)

**Interfaces:**
- Produces: `shouldPromptRouteChoice(leg, ctx) -> boolean`, where
  - `leg` has `{ routeOptions, routeVariant, _promptedRouteChoice, manualDistance, category }`
  - `ctx` has `{ editable: boolean, modalOpen: boolean }`
  - Returns `true` only when **all** hold: `ctx.editable`, `!ctx.modalOpen`, `leg.routeOptions` is truthy (a real fork was fetched), `!leg.routeVariant` (undecided), `!leg._promptedRouteChoice` (not already auto-prompted), `!leg.manualDistance`, and `leg.category !== 'stay_day'`.

- [ ] **Step 1: Write the failing unit test**

Create `web-tests/unit/ops-route-choice-trigger.test.js`:

```js
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// shouldPromptRouteChoice is a self-contained guard (no DOM, no state) inside ops-ui.html —
// extract it by source markers and eval it, same trick as ops-route-note.test.js.
function loadFn() {
  const html = readFileSync(path.resolve(__dirname, '../../api/src/routes/ops-ui.html'), 'utf8');
  const m = html.match(/function shouldPromptRouteChoice\(leg, ctx\) \{[\s\S]*?\n\}/);
  if (!m) throw new Error('shouldPromptRouteChoice not found in ops-ui.html');
  // eslint-disable-next-line no-new-func
  return new Function('return (' + m[0] + ')')();
}
const should = loadFn();
const OPTS = { fastest: { km: 292, durationMin: 330 }, noTolls: { km: 205, durationMin: 390 } };
const leg = (o) => ({ routeOptions: OPTS, category: 'drives', ...o });
const ctx = (o) => ({ editable: true, modalOpen: false, ...o });

describe('shouldPromptRouteChoice', () => {
  it('prompts on a fresh fork while editable', () => {
    expect(should(leg({}), ctx({}))).toBe(true);
  });
  it('does not prompt when no variants were fetched', () => {
    expect(should(leg({ routeOptions: null }), ctx({}))).toBe(false);
  });
  it('does not prompt once a variant is chosen', () => {
    expect(should(leg({ routeVariant: 'fastest' }), ctx({}))).toBe(false);
  });
  it('does not prompt twice (already prompted flag)', () => {
    expect(should(leg({ _promptedRouteChoice: true }), ctx({}))).toBe(false);
  });
  it('does not prompt while a modal is already open', () => {
    expect(should(leg({}), ctx({ modalOpen: true }))).toBe(false);
  });
  it('does not prompt on a locked (non-editable) quote', () => {
    expect(should(leg({}), ctx({ editable: false }))).toBe(false);
  });
  it('does not prompt on a manual-distance leg', () => {
    expect(should(leg({ manualDistance: true }), ctx({}))).toBe(false);
  });
  it('does not prompt on a stay leg', () => {
    expect(should(leg({ category: 'stay_day' }), ctx({}))).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:unit -- ops-route-choice-trigger` (from repo root; runs Vitest over `web-tests/unit`)
Expected: FAIL — `shouldPromptRouteChoice not found in ops-ui.html`.

- [ ] **Step 3: Add the pure function**

In `api/src/routes/ops-ui.html`, immediately **above** `async function compareRoutes(legId) {` (line ~4972), insert:

```js
// Route choice (2026-07-21): pure guard for the auto-open modal. Self-contained (no DOM,
// no closure state) so web-tests can extract + eval it. Returns true only when a leg has a
// real, undecided fork and it is safe to interrupt the operator exactly once.
function shouldPromptRouteChoice(leg, ctx) {
  if (!leg || !ctx) return false;
  if (!ctx.editable || ctx.modalOpen) return false;
  if (!leg.routeOptions) return false;          // no fork was fetched
  if (leg.routeVariant) return false;           // already decided
  if (leg._promptedRouteChoice) return false;   // already auto-prompted once
  if (leg.manualDistance) return false;
  if (leg.category === 'stay_day') return false;
  return true;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run test:unit -- ops-route-choice-trigger`
Expected: PASS (all 8 cases).

- [ ] **Step 5: Commit**

```bash
git add web-tests/unit/ops-route-choice-trigger.test.js api/src/routes/ops-ui.html
git commit -m "feat(ops): pure shouldPromptRouteChoice guard for route modal"
```

---

## Task 3: The route-choice modal — render, state, pick/dismiss (opened on demand)

Add the modal shell + two option cards, wired to open from the existing "Compare routes" action so it is exercisable before auto-open exists. The map is a placeholder container here (Task 4 fills it).

**Files:**
- Modify: `api/src/routes/ops-ui.html`
  - CSS: add a `.ch-rc-*` block near the `.ch-modal` styles (~line 985).
  - State: add `var routeModalLegId = null;` with the other modal flags (~line 4933 area).
  - Render: add a modal block after the "Mark booked" modal (~line 4596).
  - Handlers: repoint the `compareRoutes` action to open the modal; add pick/dismiss actions in the click delegation (~line 4815).
- Test: `web-tests/e2e/ops-quote-route-choice.spec.js` (extend)

**Interfaces:**
- Consumes: `isEditableNow()`, `updateLeg(legId, patch)`, `getLegBreakdownPrice(idx)`, `routeText(leg)`, `state.legs`, existing `routeFastest`/`routeNoTolls` apply logic.
- Produces:
  - State `routeModalLegId: string | null` (the leg the modal is open for).
  - `openRouteModal(legId)` — sets `routeModalLegId`, calls `render()`.
  - `closeRouteModal(markPrompted: boolean)` — clears it; when `markPrompted`, sets `leg._promptedRouteChoice = true`.
  - `pickRoute(legId, variant)` — `variant` is `'fastest'|'no_tolls'`; applies km/duration + `routeVariant`, marks prompted, closes.
  - data-actions: `openRouteModal`, `routeModalPickFast`, `routeModalPickLocal`, `routeModalDismiss`.

- [ ] **Step 1: Write the failing e2e**

Append to `web-tests/e2e/ops-quote-route-choice.spec.js` (follow the file's existing setup helpers for building a Colombo↔Ella leg — the FakeMaps pair returns a fork):

```js
test('compare-routes action opens the modal with both option cards', async ({ page }) => {
  await buildColomboEllaLeg(page);                 // existing helper in this spec
  await page.getByRole('button', { name: /compare routes/i }).click();
  const modal = page.locator('.ch-rc-modal');
  await expect(modal).toBeVisible();
  await expect(modal.getByText('Expressway')).toBeVisible();
  await expect(modal.getByText('Local road')).toBeVisible();
  await expect(modal.getByText(/335 km|4h 58m/)).toBeVisible();
});

test('picking local road updates the leg and appends the note; dismiss keeps the default', async ({ page }) => {
  await buildColomboEllaLeg(page);
  await page.getByRole('button', { name: /compare routes/i }).click();
  await page.locator('.ch-rc-card[data-route="local"]').click();
  await page.getByRole('button', { name: /use local road/i }).click();
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
  await expect(page.getByText('(via local road, no highway tolls)')).toBeVisible();
});
```

> If `buildColomboEllaLeg` does not yet exist in the spec, factor the leg-building steps already used by the file's first test into that helper as Step 1a, then use it.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- ops-quote-route-choice`
Expected: FAIL — `.ch-rc-modal` never appears (the action still shows pills).

- [ ] **Step 3: Add modal state**

Near the other modal flags (search `var ratesOpen`/`bookOpen`), add:

```js
var routeModalLegId = null; // legId the route-choice modal is open for, or null
```

- [ ] **Step 4: Add the CSS block**

After the `.ch-modal-body` rule (~line 985), add:

```css
.qv .ch-rc-modal .ch-rc-body { display: flex; gap: 16px; }
.qv .ch-rc-map { flex: 0 0 220px; min-height: 300px; border: 1px solid var(--line); border-radius: var(--r-md); overflow: hidden; background: var(--surface-warm); }
.qv .ch-rc-cards { flex: 1; display: flex; flex-direction: column; gap: 10px; min-width: 0; }
.qv .ch-rc-card { text-align: left; background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-md); padding: 12px 14px; cursor: pointer; }
.qv .ch-rc-card[data-route="fastest"].is-sel { border-color: #2F6FE0; box-shadow: inset 0 0 0 1px #2F6FE0; }
.qv .ch-rc-card[data-route="local"].is-sel { border-color: #BA7517; box-shadow: inset 0 0 0 1px #BA7517; }
.qv .ch-rc-name { font-weight: 700; font-size: 14px; }
.qv .ch-rc-hero { font-size: 20px; font-weight: 700; margin: 6px 0 2px; }
.qv .ch-rc-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; font-size: 12px; color: var(--muted); }
.qv .ch-rc-fit { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--line); font-size: 12px; color: var(--muted); }
.qv .ch-rc-swatch-fast { color: #2F6FE0; } .qv .ch-rc-swatch-local { color: #BA7517; }
```

- [ ] **Step 5: Render the modal**

After the "Mark booked" modal block (line ~4596), add a block that renders when `routeModalLegId` is set. Adapt the approved mock's two-card layout into the string-concat idiom (blue = fastest/current, amber = local; each card leads with its strength; stat grid of the other metrics; a "best for" line). Use `getRouteModalData(routeModalLegId)` (added in Step 6) for values:

```js
    // ══ Route-choice modal ══
    (routeModalLegId ? (function () {
      var d = getRouteModalData(routeModalLegId); if (!d) return '';
      return [
        '<div class="ch-scrim show" data-action="routeModalDismiss"></div>',
        '<div class="ch-modal ch-rc-modal">',
        '  <div class="ch-modal-card">',
        '    <div class="ch-modal-head">',
        '      <h2>Two routes for this leg</h2>',
        '      <button class="ch-x-btn" data-action="routeModalDismiss" title="Keep default and close">&times;</button>',
        '    </div>',
        '    <div class="ch-modal-body">',
        '      <div class="ch-lock-note">' + esc(d.from) + ' &rarr; ' + esc(d.to) + ' &middot; pick which one to quote</div>',
        '      <div class="ch-rc-body">',
        '        <div class="ch-rc-map" id="route-modal-map"></div>',
        '        <div class="ch-rc-cards">',
        '          <button class="ch-rc-card' + (d.selected === 'fastest' ? ' is-sel' : '') + '" data-route="fastest" data-action="routeModalSelectFast">',
        '            <div class="ch-rc-name"><span class="ch-rc-swatch-fast">&#9473;</span> Expressway &middot; current</div>',
        '            <div class="ch-rc-hero">' + esc(d.fast.time) + '</div>',
        '            <div class="ch-rc-stats"><span>' + esc(d.fast.km) + '</span><span>Tolled</span><span>' + esc(d.fast.price) + '</span></div>',
        '            <div class="ch-rc-fit">Best for tight flight connections</div>',
        '          </button>',
        '          <button class="ch-rc-card' + (d.selected === 'no_tolls' ? ' is-sel' : '') + '" data-route="local" data-action="routeModalSelectLocal">',
        '            <div class="ch-rc-name"><span class="ch-rc-swatch-local">&#9548;</span> Local road</div>',
        '            <div class="ch-rc-hero">' + esc(d.local.price) + ' <span style="font-size:12px;color:#BA7517">' + esc(d.local.save) + '</span></div>',
        '            <div class="ch-rc-stats"><span>' + esc(d.local.time) + '</span><span>' + esc(d.local.km) + '</span><span>Toll-free</span></div>',
        '            <div class="ch-rc-fit">Best for budget or scenic hill country</div>',
        '          </button>',
        '        </div>',
        '      </div>',
        '      <div style="display:flex;justify-content:space-between;align-items:center;margin-top:16px">',
        '        <button class="ch-link" data-action="routeModalDismiss">Keep expressway, decide later</button>',
        '        <button class="ch-btn ch-btn-teal" data-action="' + (d.selected === 'no_tolls' ? 'routeModalPickLocal' : 'routeModalPickFast') + '">' + (d.selected === 'no_tolls' ? 'Use local road' : 'Use expressway') + '</button>',
        '      </div>',
        '    </div>',
        '  </div>',
        '</div>',
      ].join('');
    })() : ''),
```

- [ ] **Step 6: Add the data builder + open/close/pick helpers**

Near `compareRoutes` (~line 4972), add. `getRouteModalData` reads the leg + its `routeOptions` and formats display strings; the selected variant defaults to `'fastest'` when undecided (matches "current"). `fmtDur` and `fmtMoney`/price already exist in the file — reuse them (grep to confirm the exact helper names; use `fmtDur(min/60)` for durations):

```js
function getRouteModalData(legId) {
  var leg = state.legs.find(function (l) { return l.id === legId; });
  if (!leg || !leg.routeOptions) return null;
  var f = leg.routeOptions.fastest, n = leg.routeOptions.noTolls;
  var saveMinor = 0; // price delta is display-only; compute from per-variant estimate if available, else omit
  return {
    from: (leg.pickupLocation || '').trim(),
    to: (leg.dropoffLocation || '').trim(),
    selected: leg.routeVariant || 'fastest',
    fast:  { time: fmtDur(f.durationMin / 60), km: f.km + ' km', price: routeVariantPrice(legId, 'fastest') },
    local: { time: fmtDur(n.durationMin / 60), km: n.km + ' km', price: routeVariantPrice(legId, 'no_tolls'), save: routeVariantSaving(legId) },
  };
}
function openRouteModal(legId) { routeModalLegId = legId; render(); }
function closeRouteModal(markPrompted) {
  var legId = routeModalLegId; routeModalLegId = null;
  if (markPrompted && legId) { var l = state.legs.find(function (x) { return x.id === legId; }); if (l) l._promptedRouteChoice = true; }
  render();
}
function pickRoute(legId, variant) {
  var leg = state.legs.find(function (l) { return l.id === legId; });
  var opt = leg && leg.routeOptions && (variant === 'no_tolls' ? leg.routeOptions.noTolls : leg.routeOptions.fastest);
  if (opt) {
    updateLeg(legId, { distanceKm: opt.km, driveTimeHours: Math.round((opt.durationMin / 60) * 100) / 100, routeVariant: variant, manualDistance: false, autoMatched: true });
    var l = state.legs.find(function (x) { return x.id === legId; }); if (l) l._promptedRouteChoice = true;
  }
  routeModalLegId = null; render();
}
```

> `routeVariantPrice(legId, variant)` / `routeVariantSaving(legId)`: v1 may show the price of the currently-applied variant and omit the cross-variant saving if a per-variant estimate isn't cheaply available. If the estimate engine can price a hypothetical variant km without a round-trip, use it; otherwise return the leg's current price for the applied side and `''` for the saving, and note this in the PR. Keep the cards honest — never show a fabricated saving.

- [ ] **Step 7: Wire the actions + repoint compareRoutes**

In the click delegation (`else if (action === 'compareRoutes')`, ~line 4815), replace the body so the existing button opens the modal, and add the new actions:

```js
    } else if (action === 'compareRoutes' || action === 'openRouteModal') {
      // Ensure variants are loaded, then open the modal.
      (async function () {
        var leg = state.legs.find(function (l) { return l.id === legId; });
        if (leg && !leg.routeOptions) { await compareRoutes(legId); }
        var l2 = state.legs.find(function (l) { return l.id === legId; });
        if (l2 && l2.routeOptions) openRouteModal(legId);
      })();
    } else if (action === 'routeModalSelectFast') {
      _rcSel = 'fastest'; render();   // display-only highlight; nothing commits until "Use"
    } else if (action === 'routeModalSelectLocal') {
      _rcSel = 'no_tolls'; render();
    } else if (action === 'routeModalPickFast') {
      pickRoute(routeModalLegId, 'fastest');
    } else if (action === 'routeModalPickLocal') {
      pickRoute(routeModalLegId, 'no_tolls');
    } else if (action === 'routeModalDismiss') {
      closeRouteModal(true);
    }
```

> Selection-before-commit: add `var _rcSel = null;` module state and have `getRouteModalData` prefer `_rcSel` over `leg.routeVariant` for the `selected` field; reset `_rcSel = null` in `openRouteModal`/`closeRouteModal`/`pickRoute`. This lets a click highlight a card (and, in Task 4, emphasize its map line) before "Use" commits.

- [ ] **Step 8: Run the e2e to verify green**

Run: `npm run test:e2e -- ops-quote-route-choice`
Expected: PASS (modal opens; local pick applies the note; dismiss closes).

- [ ] **Step 9: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-quote-route-choice.spec.js
git commit -m "feat(ops): route-choice modal (render, select, pick, dismiss)"
```

---

## Task 4: Draw both routes on the modal map

**Files:**
- Modify: `api/src/routes/ops-ui.html` — add `syncRouteModalMap()` and call it from the post-render hook that already runs `syncItinMap()`.

**Interfaces:**
- Consumes: `loadMapsJs()`, `mapsLibs()`, `routeLoc(name)`, `state.legs`, `routeModalLegId`, `_rcSel`.
- Produces: `syncRouteModalMap()` — when the modal is open, draws two `computeRoutes` results (default + `avoidTolls`) into `#route-modal-map`, blue for fastest / amber for local, with the selected one emphasized.

- [ ] **Step 1: Add the map sync function**

Model it on `drawItinRoute` (line ~5122). Two `computeRoutes` calls for the same origin/destination — the second with toll avoidance — then draw both polylines:

```js
var _rcMapMap = null, _rcMapSig = null;
async function syncRouteModalMap() {
  var host = document.getElementById('route-modal-map');
  if (!host || !routeModalLegId) { _rcMapMap = null; return; }
  var leg = state.legs.find(function (l) { return l.id === routeModalLegId; });
  if (!leg) return;
  var from = (leg.pickupLocation || '').trim(), to = (leg.dropoffLocation || '').trim();
  var sig = from + '||' + to + '||' + (_rcSel || leg.routeVariant || 'fastest');
  if (sig === _rcMapSig && _rcMapMap) return;
  _rcMapSig = sig;
  var ok = await loadMapsJs(); var libs = ok ? await mapsLibs() : null;
  if (!libs) { host.innerHTML = '<div class="ch-itin-map-note">Route map could not load.</div>'; return; }
  if (!_rcMapMap || _rcMapMap.__host !== host) {
    host.innerHTML = '';
    _rcMapMap = new libs.Map(host, { center: { lat: 7.6, lng: 80.9 }, zoom: 7, disableDefaultUI: true, gestureHandling: 'none', clickableIcons: false });
    _rcMapMap.__host = host;
  }
  var sel = _rcSel || leg.routeVariant || 'fastest';
  async function draw(avoidTolls, color, emphasized) {
    try {
      var res = await libs.Route.computeRoutes({
        origin: routeLoc(from), destination: routeLoc(to), travelMode: 'DRIVING', region: 'lk',
        routeModifiers: avoidTolls ? { avoidTolls: true } : undefined, fields: ['path', 'viewport'],
      });
      var route = res && res.routes && res.routes[0]; if (!route) return null;
      route.createPolylines().forEach(function (p) {
        p.setOptions({ strokeColor: color, strokeWeight: emphasized ? 6 : 3, strokeOpacity: emphasized ? 0.95 : 0.5, zIndex: emphasized ? 3 : 1 });
        p.setMap(_rcMapMap);
      });
      return route;
    } catch (e) { return null; }
  }
  if (_rcMapMap.__lines) { _rcMapMap.__lines.forEach(function (p) { p.setMap(null); }); }
  _rcMapMap.__lines = [];
  var rf = await draw(false, '#2F6FE0', sel === 'fastest');
  var rn = await draw(true, '#BA7517', sel === 'no_tolls');
  var vp = (sel === 'no_tolls' ? rn : rf) && ((sel === 'no_tolls' ? rn : rf).viewport);
  if (vp) _rcMapMap.fitBounds(vp, 24);
}
```

> Note: `createPolylines()` returns fresh polylines each call; track them on `_rcMapMap.__lines` so the previous selection's lines are cleared before redraw. Confirm the exact toll-avoidance field name against the loaded Routes library (`routeModifiers.avoidTolls`); adjust if the wrapper differs.

- [ ] **Step 2: Call it from the post-render hook**

Find where `syncItinMap()` is invoked after `render()` (grep `syncItinMap(`) and add `syncRouteModalMap();` immediately after it, so the modal map draws/refreshes on every render (open, select, close).

- [ ] **Step 3: Verify in the browser preview**

Google Maps rendering isn't unit/e2e-testable. Start the dev server, build a Colombo→Ella leg, open the modal:
Run: `cd api && npm run dev` → open `http://localhost:8787/ops` → build the leg → click Compare routes.
Confirm: two lines (solid blue expressway, dashed-styled amber local), the selected one bolder; clicking the other card re-emphasizes its line. Capture a screenshot for the PR.

- [ ] **Step 4: Commit**

```bash
git add api/src/routes/ops-ui.html
git commit -m "feat(ops): draw both routes on the route-choice modal map"
```

---

## Task 5: Proactive fetch + auto-open on a real fork

Make the fork detection happen automatically when a point-to-point leg resolves, and auto-open the modal through the Task 2 guard.

**Files:**
- Modify: `api/src/routes/ops-ui.html` — extend `runAutoDistance` (line ~4942) to fetch variants and auto-open.
- Test: `web-tests/e2e/ops-quote-route-choice.spec.js` (extend)

**Interfaces:**
- Consumes: `shouldPromptRouteChoice(leg, ctx)`, `isEditableNow()`, `openRouteModal(legId)`, `apiDistance(from, to, true)`.
- Produces: after a point-to-point leg auto-resolves, `leg.routeOptions` is populated when the pair has a fork, and the modal auto-opens once (guarded).

- [ ] **Step 1: Write the failing e2e**

```js
test('a fork leg auto-opens the modal once; a same-route leg does not', async ({ page }) => {
  await gotoOpsNewQuote(page);                       // existing helper
  await setLeg(page, 0, 'Colombo City', 'Ella');     // FakeMaps → fork
  await expect(page.locator('.ch-rc-modal')).toBeVisible();   // auto-opened
  await page.getByRole('button', { name: /keep expressway, decide later/i }).click();
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
  // Re-render (e.g. edit the date) must NOT re-pop it:
  await setLegDate(page, 0, nextWeekIso());
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);

  await setLeg(page, 1 /* new leg */, 'Colombo Airport (CMB)', 'Negombo'); // no fork
  await expect(page.locator('.ch-rc-modal')).toHaveCount(0);
});
```

> Use the spec's existing helpers (`gotoOpsNewQuote`, `setLeg`, date helpers). If a "Negombo" no-fork pair isn't in `FAKE_VARIANT_PAIRS`, pick any pair not listed there — `distanceVariants` returns `hasChoice:false` for unlisted pairs.

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- ops-quote-route-choice`
Expected: FAIL — the modal never auto-opens (fetch is still on-demand).

- [ ] **Step 3: Extend `runAutoDistance` to fetch variants + auto-open**

At the end of the successful branch of `runAutoDistance` (after the `updateLeg(...autoMatched:true)` on line ~4965), add a proactive compare + guarded auto-open:

```js
    // Route choice (2026-07-21): proactively check for a materially different toll-free route
    // and auto-open the modal once, guarded. Point-to-point driving legs only.
    if (current.category !== 'stay_day' && !current.manualDistance) {
      var v = await apiDistance(from, to, true);
      var live = state.legs.find(function (l) { return l.id === legId; });
      if (live && (live.pickupLocation || '').trim() === from && (live.dropoffLocation || '').trim() === to && !live.manualDistance) {
        if (v && v.variants) { live.routeOptions = v.variants; live._sameRoute = false; }
        else { live._sameRoute = true; }
        render();
        if (shouldPromptRouteChoice(live, { editable: isEditableNow(), modalOpen: !!routeModalLegId })) {
          openRouteModal(legId);
        }
      }
    }
```

> This adds one extra `/admin/quote/distance?compare=true` call per resolved point-to-point leg; `maps.ts` caches variants 24h so re-renders/edits don't re-bill. Keep the existing stale-response guards.

- [ ] **Step 4: Run the e2e to verify green**

Run: `npm run test:e2e -- ops-quote-route-choice`
Expected: PASS (auto-opens on the fork, no re-pop on re-render, silent on the no-fork leg).

- [ ] **Step 5: Run the full web-tests + api check**

Run: `npm run test:all` and `cd api && npm run check`
Expected: PASS (no regression in `ops-route-note` or existing route-choice specs).

- [ ] **Step 6: Commit**

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-quote-route-choice.spec.js
git commit -m "feat(ops): proactively detect route forks and auto-open the modal"
```

---

## Task 6: Remove the Phase 1 pills; add the compact inline chip

Retire the inline two-pill picker (the modal is now the picker) and replace the "Compare routes" whisper-link with a compact chip that reflects state and opens the modal.

**Files:**
- Modify: `api/src/routes/ops-ui.html` — the route-choice render block (lines ~3079-3097) and remove the now-unused `routeFastest`/`routeNoTolls` pill actions if nothing else references them.
- Test: `web-tests/e2e/ops-quote-route-choice.spec.js` (extend/adjust)

**Interfaces:**
- Consumes: `leg.routeOptions`, `leg.routeVariant`, `leg._sameRoute`.
- Produces: on a fork leg — a chip reading `Compare routes` (undecided) or `Route: Expressway ▾` / `Route: Local road ▾` (decided), both `data-action="openRouteModal"`. No pills.

- [ ] **Step 1: Update the e2e expectations**

Adjust/add in the spec:

```js
test('a decided leg shows a route chip that reopens the modal', async ({ page }) => {
  await gotoOpsNewQuote(page);
  await setLeg(page, 0, 'Colombo City', 'Ella');
  await page.locator('.ch-rc-card[data-route="local"]').click();
  await page.getByRole('button', { name: /use local road/i }).click();
  await expect(page.getByRole('button', { name: /route: local road/i })).toBeVisible();
  await page.getByRole('button', { name: /route: local road/i }).click();
  await expect(page.locator('.ch-rc-modal')).toBeVisible();
  // The old inline pills are gone:
  await expect(page.locator('.ch-route-pill')).toHaveCount(0);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npm run test:e2e -- ops-quote-route-choice`
Expected: FAIL — the decided-state chip doesn't exist and `.ch-route-pill` still renders.

- [ ] **Step 3: Replace the render block**

Swap the pills/`_sameRoute`/link block (lines ~3084-3096) for the chip:

```js
      if (leg.routeOptions) {
        var picked = leg.routeVariant === 'no_tolls' ? 'Local road' : (leg.routeVariant === 'fastest' ? 'Expressway' : null);
        distHtml += picked
          ? '<div><button class="ch-link ch-route-chip" data-action="openRouteModal" data-leg="' + esc(leg.id) + '">Route: ' + esc(picked) + ' &#9662;</button></div>'
          : '<div><button class="ch-link ch-route-chip" data-action="openRouteModal" data-leg="' + esc(leg.id) + '">Compare routes</button></div>';
      } else if (leg._sameRoute) {
        distHtml += '<div class="ch-route-same">Same route — no expressway on this trip</div>';
      }
      // (Undetermined-yet legs show nothing until runAutoDistance resolves routeOptions/_sameRoute.)
```

- [ ] **Step 4: Remove dead pill handlers**

Grep `routeFastest`/`routeNoTolls`. Their apply logic now lives in `pickRoute`; if the only remaining references were the removed pill buttons, delete those two `else if` branches from the click delegation. If any other caller remains, leave them.

- [ ] **Step 5: Run e2e + full suite**

Run: `npm run test:e2e -- ops-quote-route-choice` then `npm run test:all`
Expected: PASS (chip states work; no `.ch-route-pill` in the DOM; note-copy test still green).

- [ ] **Step 6: Verify in browser + commit**

Browser-check the chip on a fork leg (undecided → `Compare routes`, decided → `Route: …`) and its absence on a no-fork leg.

```bash
git add api/src/routes/ops-ui.html web-tests/e2e/ops-quote-route-choice.spec.js
git commit -m "feat(ops): replace route pills with a compact chip that opens the modal"
```

---

## Self-review (against the spec)

- **Trigger (proactive fetch + hasChoice):** Task 5 (fetch on resolve) + Task 1 (45-min bar). ✓
- **Guardrails (once/editable/undecided/one-at-a-time/re-arm):** Task 2 (pure guard, unit-tested) + Task 5 (applies guard). Re-arm on endpoint change is the existing reset in the `change`/blur handlers that already clears `routeVariant`/`routeOptions`; add `_promptedRouteChoice` to those resets. **Add to Task 6 Step 3 area / verify:** ensure the pickup/dropoff reset also clears `_promptedRouteChoice`. ✓ (call out in PR)
- **Modal UI (two honest cards + map + dismiss):** Tasks 3–4. ✓
- **On pick (routeVariant + note + reprice):** Task 3 `pickRoute` reuses `updateLeg`; note via existing `routeText`. ✓
- **Inline affordance + change-later:** Task 6 chip. ✓
- **Locked/reopen (no re-pop, inert):** guard's `editable` + `_promptedRouteChoice` (Task 2/5); locked inertness is the existing `applyContentLock` disabling buttons — confirm the chip sits inside a `.ch-sec`/locked region so it disables too. ✓ (verify in Task 6)
- **Map = real Google map:** Task 4. ✓
- **Pills removed:** Task 6. ✓
- **Price/saving honesty:** Task 3 Step 6 explicitly forbids fabricated savings; v1 may omit the cross-variant saving if not cheaply priceable. **Open implementation note** — decide during Task 3 whether a per-variant price is available; if not, the local card omits `saves $X` rather than guessing.

**Known follow-up (not blocking v1):** if the cross-variant dollar saving can't be shown honestly without a second estimate call, either wire a lightweight per-variant estimate or ship without the saving line and revisit.
