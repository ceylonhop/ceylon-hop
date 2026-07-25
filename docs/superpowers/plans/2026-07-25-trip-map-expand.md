# Expandable Trip Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the trip map an expand button that opens a large, freely manipulable modal with a numbered stop legend, so customers unfamiliar with Sri Lanka can confirm their stops.

**Architecture:** All behaviour lives in the shared `ch-map.js` browser IIFE and is opt-in via a new `opts.expandable` flag on `renderRoute()`, so `plan.js` and `booking.js` each enable it with one argument and `index.html`/`search.html` (which use `CH_MAP.suggest` only) are untouched. The modal creates its own second map instance rather than re-parenting the inline one, keeping it isolated from the planner's re-render cycle; a `computeRoutes()` memo makes that second instance free.

**Tech Stack:** Vanilla browser JS (no build step, no framework), Google Maps JS API (async `importLibrary`), Vitest + jsdom for unit tests, Playwright for e2e.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-25-trip-map-expand-design.md`. Read it first.
- Branch `feat/map-expand`, worktree `.claude/worktrees/map-expand`, cut from `origin/main`.
- **The modal is view-only.** It must never mutate trip state — no editing, no draggable pins.
- **`ch-map.js` is shared by four pages.** All new behaviour is opt-in via `opts.expandable`; the default path must be byte-for-byte equivalent in behaviour for existing callers.
- **Modal styles ship inside `ensureStyle()`**, not in any page's `<style>`. `.plan-modal` exists only on `plan.html`; `booking.html` has `.ph-overlay`.
- **Never toggle these overlays with the `hidden` property.** Overlay classes set an explicit `display`, which beats the UA `[hidden]` rule. Use inline `style.display` or add/remove the node.
- Brand pin colours, unchanged: pick-up `#0a7d6f`, intermediate `#0AB9B6`, final drop-off `#e8623a`.
- Expand affordance renders **only** on the real Google map, never on the SVG island fallback.
- Run from `web-tests/`: `npm run test:unit` and `npx playwright test`. Both must be green before each commit.

---

## File Structure

| File | Responsibility | Change |
|---|---|---|
| `ch-map.js` | Shared map module: loader, route render, autocomplete | Modify — memo, marker labels, expand button, modal, legend, styles |
| `plan.js` | Planner summary map | Modify — 1 line, opt in |
| `booking.js` | Booking transfer map | Modify — 2 lines, opt in + labels |
| `web-tests/e2e/_stubs.js` | Shared e2e Google/PayHere stubs | Modify — record Map and Marker constructor options |
| `web-tests/unit/ch-map-route-memo.test.js` | Route memo behaviour | Create |
| `web-tests/e2e/map-expand.spec.js` | Expand button, modal, legend | Create |

---

### Task 1: Memoise `computeRoutes()`

Every `renderRoute()` call re-runs the billable `computeRoutes()`, including on each inline re-render. The modal would add another. Cache the promise per page load, keyed on the ordered stop list.

**Files:**
- Modify: `ch-map.js` (insert after `toLoc`, ~line 66; replace the call at ~lines 107-114)
- Test: `web-tests/unit/ch-map-route-memo.test.js` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `computeRouteCached(Route, stops) -> Promise<ComputeRoutesResponse>`, private to the IIFE. Later tasks do not call it directly.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/ch-map-route-memo.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const src = readFileSync(path.join(ROOT, 'ch-map.js'), 'utf8');

// ch-map.js is a browser IIFE that hangs CH_MAP off window. Re-running it per test gives
// each test a fresh closure, so the module-level route cache starts empty.
function loadChMap() {
  new Function(src)();
  return window.CH_MAP;
}

// Minimal async-Maps stub: classes come only from importLibrary, mirroring the real API.
function stubGoogle() {
  const calls = [];
  function MapCls() {}
  MapCls.prototype.fitBounds = function () {};
  function Marker() {}
  function Point() {}
  function Polyline() {}
  Polyline.prototype.setOptions = function () {};
  Polyline.prototype.setMap = function () {};
  const Route = {
    computeRoutes: async (req) => {
      calls.push(req);
      return {
        routes: [{
          viewport: {},
          legs: [{
            distanceMeters: 100000,
            durationMillis: 3600000,
            startLocation: { lat: 6.93, lng: 79.85 },
            endLocation: { lat: 7.29, lng: 80.63 },
          }],
          createPolylines: () => [new Polyline()],
        }],
      };
    },
  };
  const libs = { maps: { Map: MapCls, Polyline }, routes: { Route }, marker: { Marker }, core: { Point } };
  window.google = { maps: { importLibrary: async (n) => libs[n] || {}, event: { trigger() {} } } };
  return calls;
}

describe('renderRoute route memo', () => {
  let calls, CH_MAP;

  beforeEach(() => {
    document.body.innerHTML = '';
    window.CEYLON_MAPS_KEY = 'test-key';
    delete window.CH_MAP;
    calls = stubGoogle();
    CH_MAP = loadChMap();
  });

  const host = () => {
    const d = document.createElement('div');
    document.body.appendChild(d);
    return d;
  };

  it('computes the route once for repeated renders of the same stops', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    expect(calls).toHaveLength(1);
  });

  it('recomputes when the stop list changes', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Kandy', 'Galle']);
    expect(calls).toHaveLength(2);
  });

  it('is order sensitive', async () => {
    await CH_MAP.renderRoute(host(), ['Kandy', 'Ella']);
    await CH_MAP.renderRoute(host(), ['Ella', 'Kandy']);
    expect(calls).toHaveLength(2);
  });

  it('does not cache a failed route', async () => {
    // Make the FIRST computeRoutes reject, then succeed. A rejection must be evicted from
    // the cache, otherwise one transient failure poisons the route for the whole session.
    let shouldFail = true;
    const original = window.google.maps.importLibrary;
    window.google.maps.importLibrary = async (name) => {
      const lib = await original(name);
      if (name !== 'routes') return lib;
      return {
        Route: {
          computeRoutes: async (req) => {
            if (shouldFail) { calls.push(req); throw new Error('boom'); }
            return lib.Route.computeRoutes(req);
          },
        },
      };
    };
    // Reload so loadLibs() captures the wrapped routes library.
    delete window.CH_MAP;
    const CH = loadChMap();

    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(1);

    shouldFail = false;
    await CH.renderRoute(host(), ['Kandy', 'Ella'], { onFail() {} });
    expect(calls).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web-tests && npx vitest run unit/ch-map-route-memo.test.js
```

Expected: FAIL — "computes the route once" gets `calls.length === 2`, because `renderRoute` calls `computeRoutes` directly every time.

- [ ] **Step 3: Add the memo**

In `ch-map.js`, insert immediately after the `toLoc` definition (~line 66):

```js
  // computeRoutes() is billable and today every renderRoute() re-runs it — on each inline
  // re-render, and again when the expand modal opens. Memoise per page load, keyed on the
  // ordered stop list. The PROMISE is cached so concurrent callers share one request; a
  // rejection is evicted so a transient failure isn't cached for the rest of the session.
  const routeCache = new Map();
  function computeRouteCached(Route, stops) {
    const key = JSON.stringify(stops.map(toLoc));
    const hit = routeCache.get(key);
    if (hit) return hit;
    const p = Route.computeRoutes({
      origin: toLoc(stops[0]),
      destination: toLoc(stops[stops.length - 1]),
      intermediates: stops.slice(1, -1).map((n) => ({ location: toLoc(n) })),
      travelMode: 'DRIVING',
      region: 'lk',
      fields: ['path', 'legs', 'viewport'],
    });
    p.catch(() => routeCache.delete(key));
    routeCache.set(key, p);
    return p;
  }
```

Then replace the inline call (~lines 107-114) so the `try` block reads:

```js
      try {
        const res = await computeRouteCached(libs.Route, stops);
        route = res && res.routes && res.routes[0];
      } catch (e) { /* unroutable → fail() below */ }
```

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web-tests && npx vitest run unit/ch-map-route-memo.test.js
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Run the full suites**

```bash
cd web-tests && npm run test:unit && npx playwright test
```

Expected: unit green; e2e green (no behaviour change for existing callers).

- [ ] **Step 6: Commit**

```bash
git add ch-map.js web-tests/unit/ch-map-route-memo.test.js
git commit -m "perf(map): memoise computeRoutes per stop list

Every renderRoute() re-ran the billable computeRoutes(), including on each
inline re-render. Cache the promise per page load, keyed on the ordered
stop list; evict on rejection so a transient failure isn't sticky."
```

---

### Task 2: Number the map pins

Markers carry only generic titles (`'Pick-up'`, `'Stop 3'`) with nothing drawn on them, so a pin cannot be tied to a stop. Add a number label. This improves the existing inline map on both pages, independent of the modal.

**Files:**
- Modify: `ch-map.js` (the `pin()` factory and `new libs.Marker({...})`, ~lines 138-152)
- Modify: `web-tests/e2e/_stubs.js` (record Marker options)
- Test: `web-tests/e2e/map-expand.spec.js` (create)

**Interfaces:**
- Consumes: Task 1's `ch-map.js` edits (no API surface).
- Produces: `window.__chMarkers` in e2e — array of Marker constructor option objects, in creation order. Task 3 relies on `window.__chMaps` added in the same stub edit.

- [ ] **Step 1: Extend the e2e stubs to record constructor options**

In `web-tests/e2e/_stubs.js`, inside `installStubs()`, replace the `MapCls` and `Marker` definitions:

```js
  function MapCls(el, opts) { (window.__chMaps = window.__chMaps || []).push(opts || {}); }
  MapCls.prototype.fitBounds = function () {};
  function Marker(opts) { (window.__chMarkers = window.__chMarkers || []).push(opts || {}); }
  Marker.prototype.setMap = function () {};
```

- [ ] **Step 2: Write the failing test**

Create `web-tests/e2e/map-expand.spec.js`:

```js
import { test, expect } from '@playwright/test';
import { gotoBooking } from './_stubs.js';

// gotoBooking installs the Google/PayHere stubs and mocks the API; `path` retargets it at
// any page. With the stubs present, ch-map's loadJs() short-circuits and the REAL Google
// map path runs (no stubs => the SVG island fallback runs instead).
const gotoPlanner = (page) => gotoBooking(page, {
  path: '/plan.html',
  query: 'stops=Kandy%7CElla&pax=2&vehicle=car',
});

test('map pins are numbered so they can be matched to stops', async ({ page }) => {
  await gotoPlanner(page);
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  const labels = await page.evaluate(() =>
    (window.__chMarkers || []).map((m) => m.label && m.label.text));
  expect(labels).toEqual(['1', '2']);
});
```

- [ ] **Step 3: Run the test to verify it fails**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: FAIL — received `[undefined, undefined]`; markers have no `label`.

- [ ] **Step 4: Add the label**

In `ch-map.js`, give the pin factory a label origin so the number sits in the pin's head rather than at its tip (the path is 24×24 anchored at 12,22):

```js
        const pin = (fill) => ({
          path: 'M12 2C7.6 2 4 5.6 4 10c0 5.6 8 12 8 12s8-6.4 8-12c0-4.4-3.6-8-8-8z',
          fillColor: fill, fillOpacity: 1, strokeColor: '#ffffff', strokeWeight: 2,
          scale: 1.5, anchor: new libs.Point(12, 22), labelOrigin: new libs.Point(12, 10),
        });
```

And add the label to the marker:

```js
        stopLocs.forEach((pos, i) => {
          const first = i === 0, last = i === stopLocs.length - 1;
          new libs.Marker({
            map, position: pos, zIndex: 5,
            icon: pin(first ? '#0a7d6f' : last ? '#e8623a' : '#0AB9B6'),
            // The number ties each pin to the stops legend — without it the pins are
            // anonymous and "is stop 3 the right place?" can't be answered.
            label: { text: String(i + 1), color: '#ffffff', fontSize: '11px', fontWeight: '700' },
            title: first ? 'Pick-up' : last ? 'Drop-off' : 'Stop ' + (i + 1),
          });
        });
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: PASS.

- [ ] **Step 6: Run the full suites and commit**

```bash
cd web-tests && npm run test:unit && npx playwright test
git add ch-map.js web-tests/e2e/_stubs.js web-tests/e2e/map-expand.spec.js
git commit -m "feat(map): number the route pins

Markers carried only generic titles, so a pin couldn't be tied to a stop.
Label each pin with its stop number, positioned in the pin head."
```

---

### Task 3: Expand button and modal, opted in from the planner

**Files:**
- Modify: `ch-map.js` (`ensureStyle()`; button after `wrap.classList.add('ready')`; new `openExpanded()`; `gestureHandling` from opts)
- Modify: `plan.js:750`
- Test: `web-tests/e2e/map-expand.spec.js` (extend)

**Interfaces:**
- Consumes: Task 2's `window.__chMarkers` / `window.__chMaps` stub recording.
- Produces:
  - `renderRoute(host, names, opts)` gains `opts.expandable: boolean` (default falsy) and `opts.greedy: boolean` (default falsy).
  - `openExpanded(stops, opts) -> close()` — private to the IIFE; `opts.stopLabels` is consumed in Task 4.
  - DOM contract for tests: `.ch-map-expand` (button), `.ch-map-modal` (overlay), `.ch-map-modal-card`, `.ch-map-modal-map`, `.ch-map-close`.

- [ ] **Step 1: Write the failing tests**

Append to `web-tests/e2e/map-expand.spec.js`:

```js
test('the expand button opens a modal map and closes cleanly', async ({ page }) => {
  await gotoPlanner(page);

  const btn = page.locator('#trip-map .ch-map-expand');
  await expect(btn).toBeVisible();
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);

  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await expect(page.locator('.ch-map-modal-map .ch-map-wrap')).toBeVisible();

  // Esc closes and focus returns to the button that opened it.
  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
  await expect(btn).toBeFocused();

  // Backdrop click closes.
  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await page.locator('.ch-map-modal').click({ position: { x: 5, y: 5 } });
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);

  // Close button closes.
  await btn.click();
  await page.locator('.ch-map-close').click();
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
});

test('the modal map is freely manipulable and reuses the computed route', async ({ page }) => {
  await gotoPlanner(page);
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  const before = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  await page.locator('#trip-map .ch-map-expand').click();
  await expect(page.locator('.ch-map-modal-map .ch-map-wrap')).toBeVisible();

  // Inline card stays 'cooperative' so it never hijacks page scroll; the modal is 'greedy'.
  const gestures = await page.evaluate(() => (window.__chMaps || []).map((m) => m.gestureHandling));
  expect(gestures[0]).toBe('cooperative');
  expect(gestures[gestures.length - 1]).toBe('greedy');

  // The memo means opening the modal costs no extra Routes call.
  const after = await page.evaluate(() => (window.__computeRoutesReqs || []).length);
  expect(after).toBe(before);
});

test('no expand button on the SVG island fallback', async ({ page }) => {
  // No stubs installed => ch-map's loader fails => renderRoute falls back to the SVG.
  await page.route('**/maps.googleapis.com/**', (r) => r.abort());
  await page.goto('/plan.html?stops=Kandy%7CElla&pax=2&vehicle=car');

  await expect(page.locator('#trip-map svg')).toBeVisible();
  await expect(page.locator('.ch-map-expand')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: the three new tests FAIL — `.ch-map-expand` never resolves. The fallback test passes already (vacuously), which is fine.

- [ ] **Step 3: Add the modal styles**

In `ch-map.js`, append to the `st.textContent` string in `ensureStyle()` (before the closing `;`):

```js
      '.ch-map-expand{position:absolute;top:10px;right:10px;z-index:3;display:inline-flex;align-items:center;' +
      'gap:6px;padding:7px 11px;border:0;border-radius:999px;background:rgba(255,255,255,.96);color:#0a7d6f;' +
      'font-family:var(--body,system-ui,sans-serif);font-weight:700;font-size:.76rem;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,.18)}' +
      '.ch-map-expand:hover{background:#fff}' +
      '.ch-map-expand svg{width:13px;height:13px}' +
      '.ch-map-modal{position:fixed;inset:0;z-index:400;background:rgba(20,30,28,.55);display:flex;' +
      'align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(3px)}' +
      '.ch-map-modal-card{background:#fff;border-radius:18px;box-shadow:0 30px 80px rgba(0,0,0,.3);' +
      'width:min(1120px,94vw);height:min(760px,88vh);display:flex;flex-direction:column;overflow:hidden}' +
      '.ch-map-modal-head{display:flex;align-items:center;justify-content:space-between;gap:12px;' +
      'padding:14px 18px;border-bottom:1px solid #e6ebe8;font-family:var(--body,system-ui,sans-serif)}' +
      '.ch-map-modal-body{flex:1;display:flex;min-height:0}' +
      '.ch-map-modal-map{flex:1;position:relative;min-width:0}' +
      '.ch-map-modal-map .ch-map-wrap{height:100%}' +
      '.ch-map-close{border:0;background:#f1f5f3;border-radius:50%;width:32px;height:32px;cursor:pointer;' +
      'font-size:1.15rem;line-height:1;color:#2b3a35}' +
      '@media(max-width:760px){.ch-map-modal{padding:0}' +
      '.ch-map-modal-card{width:100vw;height:100dvh;border-radius:0}' +
      '.ch-map-modal-body{flex-direction:column}}';
```

- [ ] **Step 4: Make gesture handling configurable**

In `renderRoute`, change the map construction (~line 103):

```js
        // The inline card stays 'cooperative' so it never hijacks page scroll. The expand
        // modal passes greedy:true, which is the whole point of expanding — one-finger drag
        // and plain wheel zoom.
        gestureHandling: opts.greedy ? 'greedy' : 'cooperative',
```

- [ ] **Step 5: Add `openExpanded()`**

In `ch-map.js`, add above `renderRoute`:

```js
  // View-only expanded map. Creates its OWN map instance rather than re-parenting the inline
  // one: plan.js re-renders the inline map whenever trip state changes, which would yank the
  // node out from under an open modal. The route memo makes the second instance cheap.
  function openExpanded(stops, opts) {
    opts = opts || {};
    const prevFocus = document.activeElement;
    const prevOverflow = document.body.style.overflow;

    const modal = document.createElement('div');
    modal.className = 'ch-map-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-label', 'Your route, expanded');
    modal.innerHTML =
      '<div class="ch-map-modal-card">' +
        '<div class="ch-map-modal-head"><strong>Your route</strong>' +
        '<button type="button" class="ch-map-close" aria-label="Close map">×</button></div>' +
        '<div class="ch-map-modal-body"><div class="ch-map-modal-map"></div></div>' +
      '</div>';

    let closed = false;
    const close = () => {
      if (closed) return;
      closed = true;
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = prevOverflow;
      if (modal.parentNode) modal.remove();
      if (prevFocus && prevFocus.focus) prevFocus.focus();
    };
    const onKey = (e) => { if (e.key === 'Escape') close(); };

    document.addEventListener('keydown', onKey);
    modal.addEventListener('mousedown', (e) => { if (e.target === modal) close(); });
    modal.querySelector('.ch-map-close').addEventListener('click', close);

    document.body.style.overflow = 'hidden';
    document.body.appendChild(modal);
    modal.querySelector('.ch-map-close').focus();

    // No expandable flag here — never nest a modal inside a modal. A failure closes back to
    // the inline card rather than stranding an empty box.
    renderRoute(modal.querySelector('.ch-map-modal-map'), stops, { greedy: true, onFail: close });
    return close;
  }
```

- [ ] **Step 6: Render the button once the route is ready**

In `renderRoute`, immediately after `wrap.classList.add('ready');` (~line 124):

```js
      // Only on a real, successful Google map — never over the loading spinner, and never on
      // the SVG island fallback (which replaces this whole wrap).
      if (opts.expandable) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'ch-map-expand';
        btn.setAttribute('aria-label', 'Expand map');
        btn.innerHTML =
          '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" ' +
          'stroke-linecap="round" stroke-linejoin="round">' +
          '<path d="M15 3h6v6M9 21H3v-6M21 3l-7 7M3 21l7-7"/></svg><span>Expand</span>';
        btn.addEventListener('click', () => openExpanded(stops, { stopLabels: opts.stopLabels }));
        wrap.appendChild(btn);
      }
```

- [ ] **Step 7: Opt the planner in**

In `plan.js`, line 750:

```js
  if(!gapSet.size && window.CH_MAP && names.length>=2){ window.CH_MAP.renderRoute(host, names, { expandable:true, onFail(){ host.innerHTML=svg; } }); }
```

- [ ] **Step 8: Run the tests to verify they pass**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: PASS, 4 tests.

- [ ] **Step 9: Run the full suites and commit**

```bash
cd web-tests && npm run test:unit && npx playwright test
git add ch-map.js plan.js web-tests/e2e/map-expand.spec.js
git commit -m "feat(map): expandable route map on the planner

Adds a view-only expand modal with greedy gesture handling, so customers
can actually zoom and pan to confirm their stops. Opens its own map
instance (isolated from the planner's re-render cycle); the route memo
means it costs no extra Routes call."
```

---

### Task 4: Numbered stops legend in the modal

**Files:**
- Modify: `ch-map.js` (`ensureStyle()`; `openExpanded()` markup)
- Test: `web-tests/e2e/map-expand.spec.js` (extend)

**Interfaces:**
- Consumes: `openExpanded(stops, opts)` and `opts.stopLabels` from Task 3.
- Produces: DOM contract `.ch-map-legend`, `.ch-map-legend li`, `.ch-map-legend .ch-lg-n`.

- [ ] **Step 1: Write the failing test**

Append to `web-tests/e2e/map-expand.spec.js`:

```js
test('the modal lists the stops, numbered and colour-matched to the pins', async ({ page }) => {
  await gotoBooking(page, { path: '/plan.html', query: 'stops=Kandy%7CElla%7CGalle&pax=2&vehicle=car' });
  await expect(page.locator('#trip-map .ch-map-wrap.ready')).toBeVisible();

  await page.locator('#trip-map .ch-map-expand').click();
  const items = page.locator('.ch-map-legend li');
  await expect(items).toHaveCount(3);
  await expect(items.nth(0)).toContainText('Kandy');
  await expect(items.nth(1)).toContainText('Ella');
  await expect(items.nth(2)).toContainText('Galle');
  await expect(items.nth(0).locator('.ch-lg-n')).toHaveText('1');
  await expect(items.nth(2).locator('.ch-lg-n')).toHaveText('3');

  // Pick-up green, final drop-off orange — matching the pin colours.
  await expect(items.nth(0).locator('.ch-lg-n')).toHaveCSS('background-color', 'rgb(10, 125, 111)');
  await expect(items.nth(2).locator('.ch-lg-n')).toHaveCSS('background-color', 'rgb(232, 98, 58)');
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web-tests && npx playwright test map-expand.spec.js -g "lists the stops"
```

Expected: FAIL — `.ch-map-legend li` resolves to 0 elements.

- [ ] **Step 3: Add the legend styles**

Append to the `ensureStyle()` string, before the `@media` block so the mobile override still wins:

```js
      '.ch-map-legend{width:248px;flex:none;border-left:1px solid #e6ebe8;overflow:auto;padding:14px 16px;' +
      'font-family:var(--body,system-ui,sans-serif)}' +
      '.ch-map-legend ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}' +
      '.ch-map-legend li{display:flex;align-items:center;gap:10px;font-size:.86rem;color:#2b3a35}' +
      '.ch-map-legend .ch-lg-n{width:22px;height:22px;border-radius:50%;flex:none;display:grid;' +
      'place-items:center;color:#fff;font-weight:700;font-size:.72rem}' +
```

And extend the existing mobile media block to stack the legend under the map:

```js
      '@media(max-width:760px){.ch-map-modal{padding:0}' +
      '.ch-map-modal-card{width:100vw;height:100dvh;border-radius:0}' +
      '.ch-map-modal-body{flex-direction:column}' +
      '.ch-map-legend{width:auto;border-left:0;border-top:1px solid #e6ebe8;max-height:34vh}}';
```

- [ ] **Step 4: Render the legend**

In `openExpanded`, add the label helper above the `modal.innerHTML` assignment:

```js
    // A stop is a name string OR a {lat,lng} picked from Places. Callers that pass coords
    // (booking.js) supply opts.stopLabels so the legend can still name them.
    const esc = (s) => String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const labelFor = (stop, i) => {
      const given = opts.stopLabels && opts.stopLabels[i];
      if (given) return String(given).replace(/\s*\(.*?\)/, '');
      if (typeof stop === 'string') return stop.replace(/\s*\(.*?\)/, '');
      return 'Stop ' + (i + 1);
    };
    const legend = stops.map((s, i) => {
      const fill = i === 0 ? '#0a7d6f' : i === stops.length - 1 ? '#e8623a' : '#0AB9B6';
      return '<li><span class="ch-lg-n" style="background:' + fill + '">' + (i + 1) + '</span>' +
             '<span>' + esc(labelFor(s, i)) + '</span></li>';
    }).join('');
```

Then change the body markup line to include it:

```js
        '<div class="ch-map-modal-body"><div class="ch-map-modal-map"></div>' +
        '<aside class="ch-map-legend"><ol>' + legend + '</ol></aside></div>' +
```

- [ ] **Step 5: Run the test to verify it passes**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: PASS, 5 tests.

- [ ] **Step 6: Run the full suites and commit**

```bash
cd web-tests && npm run test:unit && npx playwright test
git add ch-map.js web-tests/e2e/map-expand.spec.js
git commit -m "feat(map): numbered stops legend in the expanded map

Pins are numbered but still need naming. The legend colour-matches each
number to its pin so a customer can tell which stop is which."
```

---

### Task 5: Opt the booking transfer map in

The booking step is where a wrong pin costs money. It passes `{lat,lng}` objects rather than names, so it must supply `stopLabels` for the legend.

**Files:**
- Modify: `booking.js:456`
- Test: `web-tests/e2e/map-expand.spec.js` (extend)

**Interfaces:**
- Consumes: `opts.expandable` and `opts.stopLabels` from Tasks 3-4.
- Produces: nothing further.

- [ ] **Step 1: Write the failing test**

Append to `web-tests/e2e/map-expand.spec.js`:

```js
test('the booking transfer map is expandable too', async ({ page }) => {
  await gotoBooking(page);
  await page.evaluate(() => window.goStep && window.goStep(2));

  const btn = page.locator('#rm-canvas .ch-map-expand');
  await expect(btn).toBeVisible();

  await btn.click();
  await expect(page.locator('.ch-map-modal')).toBeVisible();
  await expect(page.locator('.ch-map-legend li')).toHaveCount(2);

  await page.keyboard.press('Escape');
  await expect(page.locator('.ch-map-modal')).toHaveCount(0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
cd web-tests && npx playwright test map-expand.spec.js -g "booking transfer map"
```

Expected: FAIL — `#rm-canvas .ch-map-expand` never appears.

- [ ] **Step 3: Opt in**

In `booking.js`, change the `renderRoute` options object opened at line 456:

```js
    window.CH_MAP.renderRoute(canvas, [pFrom, pTo], {
      expandable: true,
      // pFrom/pTo may be {lat,lng} picked from Places; give the legend real names.
      stopLabels: [fromName, toName],
      onFail: showFallback,
```

Leave `onRoute` and the rest of the object unchanged.

- [ ] **Step 4: Run the test to verify it passes**

```bash
cd web-tests && npx playwright test map-expand.spec.js
```

Expected: PASS, 6 tests.

- [ ] **Step 5: Run the full suites**

```bash
cd web-tests && npm run test:unit && npx playwright test
```

Expected: unit 335+ green; e2e green.

- [ ] **Step 6: Verify visually in the browser**

Serve the worktree and check both pages by eye — CLAUDE.md requires visual changes be confirmed in a preview, not only by tests:

```bash
python3 -m http.server 8123
```

Check `http://localhost:8123/plan.html?stops=Kandy|Ella&pax=2&vehicle=car`: the Expand pill sits top-right without colliding with Google's zoom cluster; the modal leaves visible backdrop on all sides; legend numbers match the pin numbers. Resize to 375px wide and confirm the legend stacks under the map. Stop the server afterwards.

- [ ] **Step 7: Commit and open the PR**

```bash
git add booking.js web-tests/e2e/map-expand.spec.js
git commit -m "feat(map): expandable transfer map on the booking page

The booking step is where a wrong pin costs money. Passes stopLabels
because this caller supplies coordinates rather than place names."
git push -u origin feat/map-expand
```

Open a PR to `main` describing the change, the view-only decision, and the route-memo side benefit. Note that numbered pins alter the existing inline maps on both pages, not just the modal.

---

## Notes for the implementer

- **`gotoBooking` vs bare `page.goto`.** With `installStubs` the Google path runs; without it the loader fails and the SVG island fallback runs. Both are load-bearing in this spec's tests — don't "fix" the fallback test by adding stubs.
- **`routeStats()`** (`ch-map.js`, ~line 197) also calls `computeRoutes` directly. Leaving it uncached is deliberate and out of scope; don't fold it into the memo in this plan.
- **Don't touch `index.html` / `search.html`.** They load `ch-map.js` for `suggest` only and must be unaffected.
