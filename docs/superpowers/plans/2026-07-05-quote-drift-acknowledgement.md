# Quote-Drift Acknowledgement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a customer's exact pick-up/drop-off makes a private transfer materially longer than the standard route, warn them with a clear heads-up and hold the quoted price until they accept the higher fixed price — instead of silently changing the total.

**Architecture:** The pricing *decision* is a pure helper (`repriceDecision`) added to `transfers-data.js` and unit-tested in isolation. `booking.js`'s existing "re-price from the real Google route" hook (the `onRoute` callback in `renderRouteMap`) is rewired to consult that helper and, on material upward drift, park the new price in `state.pendingReprice` and render an acknowledgement notice that gates the step-2 **Continue** button (`#n1`) until the customer accepts. Cheaper routes and within-buffer changes keep today's behaviour, so both existing pricing e2e tests stay green.

**Tech Stack:** Vanilla browser JS (IIFE modules on `window`), Vitest + jsdom (unit), Playwright (e2e). Google Maps / PayHere / API are stubbed per-test via `web-tests/e2e/_stubs.js`.

## Global Constraints

- **Money:** whole/─2dp USD via `money(n)` → `'$'+(Math.round(n*100)/100).toFixed(2).replace(/\.00$/,'')`. Never introduce a new currency path.
- **Buffer parity:** every private leg is already priced at `round(km × 1.10)` (the +10% routing buffer, `RATE_CARD.bufferPct`). Reuse `legPrice` — do NOT re-derive rates. Car $0.46/km ($29 floor), van $0.83/km ($50 floor).
- **Backend is the source of truth for all prices** (owner ruling 2026-07-05). This feature only changes *when/how* the front-end shows an already-defined price; it introduces no new price numbers.
- **Fixed-price promise:** never silently raise the total. Increases beyond the buffer require explicit acceptance. Cheaper exact routes may still lower the price (good news, today's behaviour).
- **Frozen front-end:** `transfers-data.js`, `booking.js`, `booking.html`, `site.css` are on the frozen list (CLAUDE.md rule 3). This is a **deliberate, labelled** change — the same exception used for the GL-4 pricing sync. Keep all styling self-contained in `booking.js` (a one-time injected `<style>`); do NOT edit `site.css`.
- **Copy scope:** the reframed step-2 strings live only in `booking.html`'s static markup, which is shown for the private/location-first flow. `booking.js` overrides `#s1-title`/`#s1-sub` for trip mode (`booking.js:304-305`) and shared mode (`booking.js:458-459`) — do NOT touch those; the reframe must not leak into trip/shared journeys.
- **Test commands:** unit `cd web-tests && npm run test:unit`; e2e `cd web-tests && npm run test:e2e` (offline, no `CH_E2E_API`).

---

## File Structure

- `transfers-data.js` — **modify**: add pure `repriceDecision(anchorKm, routedKm, currentUnit, veh)` to the quote helpers and export it on `window.TRANSFERS`. One clear responsibility: decide apply / hold / confirm.
- `web-tests/unit/reprice-decision.test.js` — **create**: unit tests for `repriceDecision` via `loadTransfers()`.
- `booking.js` — **modify**: capture `state.anchorKm`; rewire the `onRoute` re-price block; add `state.pendingReprice`, `renderRepriceNote()`, `window.acceptReprice`/`window.dismissReprice`; gate `#n1` in `checkWhere`; inject notice styles once.
- `web-tests/e2e/pricing-flow.spec.js` — **modify**: add e2e tests for the acknowledgement flow + the reframed copy (existing two tests unchanged).
- `booking.html:461-499` — **modify**: reframe the step-2 copy to explicitly invite an exact hotel / pick-up spot (static strings for the private/location-first flow only; trip & shared modes override these in JS and are untouched).

---

### Task 1: Pure `repriceDecision` helper + unit tests

**Files:**
- Modify: `transfers-data.js:193-199` (after `legPrice`), `transfers-data.js:222-228` (export block)
- Test: `web-tests/unit/reprice-decision.test.js`

**Interfaces:**
- Consumes: existing `legPrice(km, veh)` → `number|null` (car/van fare with buffer + floor).
- Produces: `repriceDecision(anchorKm, routedKm, currentUnit, veh)` →
  `{ action: 'apply'|'hold'|'confirm', price: number, extraKm?: number }`
  - `'apply'` — routed price ≤ current, or no baseline: caller should adopt `price`.
  - `'hold'` — dearer but within the +10% buffer already charged: keep `currentUnit` (`price === currentUnit`).
  - `'confirm'` — dearer AND past the buffer: caller must get acknowledgement before adopting `price`; `extraKm` ≥ 1 is the rounded extra distance for the copy.

- [ ] **Step 1: Write the failing unit test**

Create `web-tests/unit/reprice-decision.test.js`:

```js
import { describe, it, expect, beforeAll } from 'vitest';
import { loadTransfers } from './_load.js';

// repriceDecision keeps the "fixed price" promise: cheaper/equal routes apply,
// dearer-but-within-buffer holds the anchor, dearer-past-buffer needs a heads-up.
// Buffer is the +10% already priced into every leg (legPrice does round(km×1.10)).
let T;
beforeAll(() => { T = loadTransfers(); });

describe('repriceDecision', () => {
  it('applies a cheaper routed price (good news)', () => {
    // legPrice(200,'car') = round(round(200×1.10)×0.46) = round(220×0.46) = 101
    const d = T.repriceDecision(240, 200, 121, 'car');
    expect(d).toEqual({ action: 'apply', price: 101 });
  });

  it('holds the anchor when dearer but inside the +10% buffer', () => {
    // anchor 200 → billable 220. routed 210 ≤ 220 → hold, even though legPrice(210)=106 > 101.
    const d = T.repriceDecision(200, 210, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('holds exactly at the buffer boundary', () => {
    // round(200×1.10) = 220; routed 220 is still inside → hold.
    const d = T.repriceDecision(200, 220, 101, 'car');
    expect(d).toEqual({ action: 'hold', price: 101 });
  });

  it('confirms a material increase past the buffer', () => {
    // routed 300 > 220, legPrice(300,'car') = round(330×0.46) = 152 > 101 → confirm, extra 100 km.
    const d = T.repriceDecision(200, 300, 101, 'car');
    expect(d).toEqual({ action: 'confirm', price: 152, extraKm: 100 });
  });

  it('uses the van rate for van quotes', () => {
    // legPrice(300,'van') = round(330×0.83) = 274 > 190 → confirm.
    const d = T.repriceDecision(200, 300, 190, 'van');
    expect(d).toEqual({ action: 'confirm', price: 274, extraKm: 100 });
  });

  it('never lets extraKm fall below 1 km', () => {
    // Contrived: dearer past buffer but tiny km delta → floor extraKm at 1.
    const d = T.repriceDecision(1, 2, 1, 'car');
    expect(d.action).toBe('confirm');
    expect(d.extraKm).toBeGreaterThanOrEqual(1);
  });

  it('falls back to apply when there is no baseline distance', () => {
    const d = T.repriceDecision(null, 300, 101, 'car');
    expect(d).toEqual({ action: 'apply', price: 152 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx vitest run unit/reprice-decision.test.js`
Expected: FAIL — `TypeError: T.repriceDecision is not a function`.

- [ ] **Step 3: Implement `repriceDecision` in `transfers-data.js`**

Insert immediately after `legPrice` (after line 199, before the `CHAUFFEUR_DAY_FEE` block):

```js
  // Decide what to do when a live routed distance comes back for a customer-set
  // route, given the price currently shown. Keeps the "fixed price" promise:
  //  - cheaper/equal, or no baseline → 'apply' (adopt the new price)
  //  - dearer but within the +10% buffer already charged → 'hold' (keep anchor)
  //  - dearer AND past the buffer → 'confirm' (needs a heads-up before it changes)
  // Buffer mirrors legPrice's round(km × 1.10). No new rates — reuse legPrice.
  function repriceDecision(anchorKm, routedKm, currentUnit, veh){
    const newPrice = legPrice(routedKm, veh);
    if(newPrice == null) return { action:'hold', price: currentUnit };
    if(!anchorKm || newPrice <= currentUnit) return { action:'apply', price: newPrice };
    if(routedKm <= Math.round(anchorKm * 1.10)) return { action:'hold', price: currentUnit };
    return { action:'confirm', price: newPrice, extraKm: Math.max(1, Math.round(routedKm - anchorKm)) };
  }
```

Then add it to the `window.TRANSFERS` export object (line 225 area) — append `repriceDecision` to the helper list:

```js
    resolvePlace, kmBetween, legPrice, tripQuote, repriceDecision,
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd web-tests && npx vitest run unit/reprice-decision.test.js`
Expected: PASS — 7 tests green.

- [ ] **Step 5: Run the full unit suite (no regressions)**

Run: `cd web-tests && npm run test:unit`
Expected: PASS — all files green (existing 144 + 7 new).

- [ ] **Step 6: Commit**

```bash
git add transfers-data.js web-tests/unit/reprice-decision.test.js
git commit -m "feat(pricing): add repriceDecision helper (apply/hold/confirm drift)"
```

---

### Task 2: Acknowledgement UI in `booking.js` (e2e-tested)

**Files:**
- Modify: `booking.js` — init (~line 102), `renderRouteMap` `onRoute` block (`booking.js:287-292`), `checkWhere` (`booking.js:624-627`), `render` (`booking.js:793`), plus new handlers + one-time style injection.
- Test: `web-tests/e2e/pricing-flow.spec.js` (append one test)

**Interfaces:**
- Consumes: `T.repriceDecision` (Task 1); existing `legPrice`, `kmBetween`; existing globals `unit`, `vehPrices`, `vehicleKey`, `r`, `state`, `render()`, `checkWhere()`, `money()`, `userSetLocation`, `perVehicle`, `isTrip`.
- Produces (page globals for the notice buttons): `window.acceptReprice()`, `window.dismissReprice()`. New DOM node `#reprice-note` inside the step-2 pickup panel. New state fields `state.anchorKm:number|null`, `state.pendingReprice:{km,extraKm,prices:{car,van}}|null`.

- [ ] **Step 1: Write the failing e2e test**

Append to `web-tests/e2e/pricing-flow.spec.js`:

```js
test('warns before a material price increase and holds the total until accepted', async ({ page }) => {
  // Stub reports a 400 km route. On load (no pick) the price must hold at the quoted $121.
  await gotoBooking(page, { routeKm: 400 });
  await expect(page.locator('#sum-total')).toHaveText('$121');

  // Customer picks a far-off drop-off → material upward drift.
  await pickPlace(page, '#loc-to', 'ac-to', 'Jaffna');

  // Heads-up appears; total is NOT changed yet; Continue is gated.
  await expect(page.locator('#reprice-note')).toBeVisible();
  await expect(page.locator('#sum-total')).toHaveText('$121');
  await expect(page.locator('#n1')).toBeDisabled();

  // Accept the higher fixed price. legPrice(400,'car') = round(440×0.46) = $202.
  await page.locator('#reprice-note button.btn-primary').click();
  await expect(page.locator('#sum-total')).toHaveText('$202');
  await expect(page.locator('#reprice-note')).toHaveCount(0);
  await expect(page.locator('#n1')).toBeEnabled();
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd web-tests && npx playwright test pricing-flow -g "warns before a material"`
Expected: FAIL — `#reprice-note` never appears; total silently becomes `$202` (today's behaviour).

- [ ] **Step 3: Capture the anchor distance + pending state at init**

In `booking.js`, immediately after the `state` object literal closes (after `booking.js:102`), add:

```js
// Baseline "standard route" distance for the pre-filled endpoints — used to judge
// how far a customer's exact pick-up/drop-off drifts before we re-price.
state.anchorKm = (window.TRANSFERS ? window.TRANSFERS.kmBetween(r.stops[0], r.stops[r.stops.length-1]) : null);
state.pendingReprice = null; // {km, extraKm, prices:{car,van}} while awaiting acknowledgement
```

- [ ] **Step 4: Rewire the `onRoute` re-price block to use the decision helper**

Replace `booking.js:287-292` (the `if(km!=null && userSetLocation ...)` block inside `onRoute`) with:

```js
        if(km!=null && userSetLocation && perVehicle && !isTrip && T && T.legPrice){
          const dec = T.repriceDecision(state.anchorKm, km, unit, vehicleKey);
          state.routeKm = km;
          if(dec.action==='confirm'){
            // Material upward drift — park the new price, warn, don't touch the total yet.
            state.pendingReprice = { km, extraKm: dec.extraKm,
              prices: { car: T.legPrice(km,'car'), van: T.legPrice(km,'van') } };
          } else {
            // 'apply' (cheaper/equal) or 'hold' (within buffer): clear any pending notice.
            state.pendingReprice = null;
            if(dec.action==='apply'){
              vehPrices = { car: T.legPrice(km,'car'), van: T.legPrice(km,'van') };
              if(dec.price!=null){ unit = dec.price; r.price = dec.price; }
              state.anchorKm = km; // the accepted route becomes the new baseline
            }
          }
          render(); checkWhere();
        }
```

- [ ] **Step 5: Add the notice renderer, accept/dismiss handlers, and one-time styles**

Add near the other `window.*` handlers (e.g. after `window.pickDep` at `booking.js:623`):

```js
function renderRepriceNote(){
  let el=document.getElementById('reprice-note');
  const p=state.pendingReprice;
  if(!p){ if(el) el.remove(); return; }
  const newPrice = p.prices[vehicleKey];
  if(!el){
    el=document.createElement('div'); el.id='reprice-note'; el.className='reprice-note';
    const wrap=document.getElementById('loc-wrap');
    if(wrap && wrap.parentNode) wrap.parentNode.insertBefore(el, wrap.nextSibling);
    else { const panel=document.querySelector('[data-panel="2"]'); if(panel) panel.appendChild(el); }
  }
  el.innerHTML =
    '<b>Heads up — this trip is longer than the standard route.</b> '+
    'Your exact stops add about '+p.extraKm+' km, so the fixed price updates from '+
    money(unit)+' to '+money(newPrice)+'.'+
    '<div class="rn-actions">'+
      '<button type="button" class="btn btn-primary btn-sm" onclick="acceptReprice()">Got it — use '+money(newPrice)+'</button>'+
      '<button type="button" class="rn-change" onclick="dismissReprice()">Change location</button>'+
    '</div>';
}
window.acceptReprice=function(){
  const p=state.pendingReprice; if(!p) return;
  vehPrices=p.prices; unit=p.prices[vehicleKey]; r.price=unit;
  state.anchorKm=p.km; state.pendingReprice=null;
  render(); checkWhere();
};
window.dismissReprice=function(){
  state.pendingReprice=null; render(); checkWhere();
  const to=document.getElementById('loc-to'); if(to) to.focus();
};
// one-time styles (site.css is frozen — keep this self-contained)
(function injectRepriceCss(){
  if(document.getElementById('reprice-css')) return;
  const s=document.createElement('style'); s.id='reprice-css';
  s.textContent='.reprice-note{margin:.75rem 0 0;padding:.85rem 1rem;border:1px solid #f0c07a;'+
    'background:#fff7ea;border-radius:12px;font-size:.9rem;line-height:1.4;color:#5c4a2a}'+
    '.reprice-note b{color:#8a5a12}'+
    '.reprice-note .rn-actions{display:flex;gap:.75rem;align-items:center;margin-top:.6rem;flex-wrap:wrap}'+
    '.reprice-note .rn-change{background:none;border:0;color:#8a5a12;text-decoration:underline;cursor:pointer;font:inherit;padding:0}';
  document.head.appendChild(s);
})();
```

- [ ] **Step 6: Call the renderer from `render()` and gate Continue in `checkWhere()`**

In `render()` (`booking.js:793`), add near the top of the function body (after its opening brace):

```js
  renderRepriceNote();
```

Replace `checkWhere` (`booking.js:624-627`) with:

```js
function checkWhere(){
  const haveWhere = isTrip ? true : (state.locFrom && state.locTo);
  document.getElementById('n1').disabled = !haveWhere || !!state.pendingReprice;
}
```

- [ ] **Step 7: Run the new e2e test to verify it passes**

Run: `cd web-tests && npx playwright test pricing-flow -g "warns before a material"`
Expected: PASS — notice shows, total holds at `$121`, `#n1` disabled, then `$202` after accept.

- [ ] **Step 8: Run the whole pricing-flow spec (existing behaviour intact)**

Run: `cd web-tests && npx playwright test pricing-flow`
Expected: PASS — 3 tests. The two existing tests (`price holds…`, `re-prices…after…drop-off` → `$101`) are unaffected because cheaper/within-buffer routes keep the `apply` path.

- [ ] **Step 9: Commit**

```bash
git add booking.js web-tests/e2e/pricing-flow.spec.js
git commit -m "feat(booking): warn before material quote increase, hold price until accepted"
```

---

### Task 3: Reframe step-2 copy to invite an exact hotel / pick-up spot

**Rationale:** Explicitly asking for the exact hotel/pick-up makes the drift acknowledgement feel expected ("you gave us your precise spot → here's the fixed price for it") instead of a surprise. Copy-only; the apply/hold/confirm logic from Tasks 1–2 is unchanged. Pre-filled city values stay (they're the baseline `anchorKm`); the copy just invites refining them.

**Files:**
- Modify: `booking.html:461-499` (static step-2 strings)
- Test: `web-tests/e2e/pricing-flow.spec.js` (append one copy-assertion test)

**Interfaces:** none (static-string + presentational change). Element ids `#s1-title`, `#loc-from`, `#loc-to` are unchanged.

- [ ] **Step 1: Write the failing copy test**

Append to `web-tests/e2e/pricing-flow.spec.js`:

```js
test('step 2 invites an exact hotel / pick-up location', async ({ page }) => {
  await gotoBooking(page); // default private route (cmb-airport → hikkaduwa)
  await expect(page.locator('#s1-title')).toHaveText('Add your exact pick-up & drop-off');
  await expect(page.locator('#loc-from')).toHaveAttribute('placeholder', 'Add your hotel, address or landmark…');
  await expect(page.locator('#loc-to')).toHaveAttribute('placeholder', 'Add your hotel, address or landmark…');
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd web-tests && npx playwright test pricing-flow -g "invites an exact hotel"`
Expected: FAIL — `#s1-title` still reads "Where are we picking you up?".

- [ ] **Step 3: Reframe the static copy in `booking.html`**

Replace the heading (`booking.html:461`):
```html
      <h2 id="s1-title">Add your exact pick-up &amp; drop-off</h2>
```

Replace the sub (`booking.html:462`):
```html
      <p class="sub" id="s1-sub">Your hotel, an address or a landmark — the more exact, the better we find you. Your fixed price covers this exact route; we&rsquo;ll confirm the time on WhatsApp.</p>
```

Replace the pick-up label + input (`booking.html:487-488`):
```html
            <div class="ac-wrap"><label>Pick-up — your hotel or address</label>
              <input id="loc-from" autocomplete="off" placeholder="Add your hotel, address or landmark…">
```

Replace the drop-off label + input (`booking.html:493-494`):
```html
            <div class="ac-wrap"><label>Drop-off — your hotel or address</label>
              <input id="loc-to" autocomplete="off" placeholder="Add your hotel, address or landmark…">
```

Replace the maps helper line (`booking.html:499`), keeping the existing inline `<svg>…</svg>` untouched — change only the trailing text:
```
Powered by maps — start typing your hotel or exact spot
```

- [ ] **Step 4: Run the copy test to verify it passes**

Run: `cd web-tests && npx playwright test pricing-flow -g "invites an exact hotel"`
Expected: PASS.

- [ ] **Step 5: Confirm trip & shared copy did NOT change**

Run: `cd web-tests && npx playwright test pricing-flow`
Expected: PASS — all 4 tests. (Trip/shared override `#s1-title` in JS, so they are unaffected; if any shared/trip spec exists it stays green.)

- [ ] **Step 6: Commit**

```bash
git add booking.html web-tests/e2e/pricing-flow.spec.js
git commit -m "copy(booking): reframe step 2 to invite an exact hotel / pick-up spot"
```

---

## Self-Review

**1. Spec coverage**
- Warn on material upward drift → Task 2 `confirm` branch + `renderRepriceNote`. ✅
- Hold the total until accepted → total is `money(calcTotal())`; while pending `unit` is unchanged, so total holds; `#n1` gated. ✅
- Increase-only / never silently raise → `confirm` never mutates `unit`; only `acceptReprice` does. ✅
- Cheaper routes still apply (no regression) → `apply` branch; existing `$101` e2e stays green. ✅
- Within-buffer changes don't wiggle the price → `hold` branch. ✅
- Show the "why" (extra km + old→new) → notice copy. ✅
- "Change location" escape hatch → `dismissReprice` clears pending, refocuses drop-off. ✅
- No new price numbers / backend is source of truth → only `legPrice` used. ✅

**2. Placeholder scan** — no TBD/TODO; all steps carry full code and exact commands. ✅

**3. Type consistency** — `repriceDecision` returns `{action, price, extraKm?}` in Task 1 and is consumed with those exact keys in Task 2. `state.pendingReprice` shape `{km, extraKm, prices:{car,van}}` is written in the `confirm` branch and read identically in `renderRepriceNote`/`acceptReprice`. Continue button id `#n1` matches `booking.html:513`. ✅

## Open questions for the owner (non-blocking; sensible defaults chosen)
- **Copy tone/wording** of the heads-up — drafted friendly ("Heads up… adds about N km"); tweak freely.
- **Notice placement** — currently in the step-2 pickup card under the address fields (where the action is). Alternative: the right-hand summary next to the Total. Easy to move.
- **Downward re-pricing** is left exactly as today (a cheaper exact route lowers the fixed price). If you'd rather the quoted price be a firm floor too (never auto-drop), that's a one-line change in the `apply` branch — say the word.
