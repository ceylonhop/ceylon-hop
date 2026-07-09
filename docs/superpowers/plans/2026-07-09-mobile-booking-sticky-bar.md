# Mobile Booking Sticky Bar Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On mobile, replace the 500px summary wall above every booking step with a slim context strip + a sticky bottom bar (live total + the step's primary CTA) + the existing summary as a tap-open bottom sheet.

**Architecture:** All new behavior is observation-only: the bar's CTA *proxies* the active panel's existing primary button (programmatic `.click()`), and MutationObservers copy text out of the existing `#summary` nodes. No pricing, validation, step-logic, or analytics code is touched. Every new style is scoped to `@media(max-width:880px)` AND a `js-mbar` body class added by JS — no JS ⇒ today's layout exactly; desktop ⇒ untouched.

**Tech Stack:** Vanilla JS/CSS in booking.html + booking.js; Playwright e2e in web-tests.

## Global Constraints (from spec)

- Mobile breakpoint is `max-width:880px` (matches existing). Desktop ≥881px must render byte-identical behavior to today.
- The panel primary button selector is `.panel.active .nav-btns .btn` (back links are `.back-link`, never `.btn`).
- New z-indexes: scrim 110, sheet (aside) 120, bar 130 — all BELOW `#ph-overlay` (300) and `.ch-consent` (9999), ABOVE `.wa-fab` (80) and header (70).
- The WhatsApp FAB must be lifted above the bar on mobile (`bottom:calc(76px + env(safe-area-inset-bottom,0px))`).
- `prefers-reduced-motion: reduce` ⇒ no sheet transition.
- CLAUDE.md rule 3: run `npm run test:all` in web-tests before opening/pushing; keep changes scoped.
- Do NOT commit `web-tests/e2e/_mobile-audit.spec.js` (diagnostic; deleted in Task 4).

---

### Task 1: Failing e2e spec for the new mobile contract

**Files:**
- Create: `web-tests/e2e/booking-mobile-bar.spec.js`

**Interfaces:**
- Produces (used by Task 2/3's implementation targets): element ids `#mstrip`, `#mbar`, `#mbar-total`, `#mbar-amt`, `#mbar-cta`, `#mbar-scrim`, body class `js-mbar`, aside sheet class `.open`, sheet close button `.s-close`.

- [ ] **Step 1: Write the failing spec**

```js
import { test, expect } from '@playwright/test';
import { gotoBooking, fillContact } from './_stubs.js';

// Mobile sticky-bar contract (spec: docs/superpowers/specs/2026-07-09-mobile-booking-sticky-bar-design.md).
// ≤880px: slim context strip on top, sticky total+CTA bar at bottom, summary card = bottom sheet.
// Desktop ≥881px: exactly today's layout (aside column, in-page buttons).

const MOBILE = { width: 390, height: 844 };

test.describe('mobile sticky bar', () => {
  test.use({ viewport: MOBILE });

  test('strip + bar visible, panel starts high, total mirrors summary', async ({ page }) => {
    await gotoBooking(page); // private CMB->Hikkaduwa, no date => When step active
    await expect(page.locator('#mstrip')).toBeVisible();
    await expect(page.locator('#mbar')).toBeVisible();
    const panel = await page.locator('.stepcard.panel.active').boundingBox();
    expect(panel.y).toBeLessThan(480); // step content on the first screen
    const strip = await page.locator('#mstrip').boundingBox();
    expect(strip.height).toBeLessThanOrEqual(90);
    const sumTotal = (await page.locator('#sum-total').textContent()).trim();
    await expect(page.locator('#mbar-amt')).toHaveText(sumTotal);
    // route reassurance present in the strip
    await expect(page.locator('#ms-route')).toContainText('→');
  });

  test('bar CTA proxies the active panel button and advances the step', async ({ page }) => {
    await gotoBooking(page); // When step: #n2 "Continue" is enabled for private
    await expect(page.locator('.panel.active[data-panel="1"]')).toBeVisible();
    await page.locator('#mbar-cta').click();
    await expect(page.locator('.panel.active[data-panel="2"]')).toBeVisible();
  });

  test('bar CTA mirrors label and disabled state on the payment step', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep(4));
    await expect(page.locator('#mbar-cta')).toContainText('Continue to secure payment');
    // terms unchecked => real #pay-btn disabled => bar CTA disabled
    const realDisabled = await page.locator('#pay-btn').isDisabled();
    expect(await page.locator('#mbar-cta').isDisabled()).toBe(realDisabled);
  });

  test('changing travelers updates the bar total live', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep(3));
    const before = (await page.locator('#mbar-amt').textContent()).trim();
    await page.evaluate(() => window.step('ad', 1)); // +1 adult via existing stepper API
    await expect(page.locator('#mbar-amt')).not.toHaveText(before);
    const sumTotal = (await page.locator('#sum-total').textContent()).trim();
    await expect(page.locator('#mbar-amt')).toHaveText(sumTotal);
  });

  test('sheet opens from total button and strip, shows perks + WhatsApp, closes via scrim and Escape', async ({ page }) => {
    await gotoBooking(page);
    await page.locator('#mbar-total').click();
    const aside = page.locator('.layout > aside');
    await expect(aside).toHaveClass(/open/);
    await expect(page.locator('.s-perks')).toBeVisible();
    await expect(page.locator('#s-wa')).toBeVisible();
    // summary keeps sensible gutters while open (moved from mobile-ux gutter test)
    const sum = await page.locator('#summary').boundingBox();
    expect(sum.x).toBeGreaterThanOrEqual(0);
    await page.locator('#mbar-scrim').click();
    await expect(aside).not.toHaveClass(/open/);
    await page.locator('#mstrip').click();
    await expect(aside).toHaveClass(/open/);
    await page.keyboard.press('Escape');
    await expect(aside).not.toHaveClass(/open/);
  });

  test('focusing a details input hides the bar; blur restores it', async ({ page }) => {
    await gotoBooking(page);
    await page.evaluate(() => window.goStep(4));
    await page.locator('#f-first').focus();
    await expect(page.locator('#mbar')).toBeHidden();
    await page.locator('#f-first').blur();
    await expect(page.locator('#mbar')).toBeVisible();
  });
});

test('desktop is unchanged: no strip/bar, aside column, in-page primary button', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await gotoBooking(page);
  await expect(page.locator('#mstrip')).toBeHidden();
  await expect(page.locator('#mbar')).toBeHidden();
  const aside = await page.locator('.layout > aside').boundingBox();
  const panel = await page.locator('.stepcard.panel.active').boundingBox();
  expect(aside.x).toBeGreaterThan(panel.x + 100); // right column, not stacked
  await expect(page.locator('.panel.active .nav-btns .btn')).toBeVisible();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd web-tests && npx playwright test booking-mobile-bar --reporter=list`
Expected: FAIL — `#mstrip` / `#mbar` do not exist (locator timeout). The desktop test may pass (elements absent) — that is fine.

- [ ] **Step 3: Commit the red spec**

```bash
git add web-tests/e2e/booking-mobile-bar.spec.js
git commit -m "test: mobile sticky-bar contract for booking (red)"
```

---

### Task 2: Markup + CSS (strip, bar, scrim, sheet styles)

**Files:**
- Modify: `booking.html` (markup after `#psteps` ~line 519; markup before `#ph-overlay` ~line 762; CSS inside the existing `@media(max-width:880px)` block at ~line 482 and after it)

**Interfaces:**
- Produces: ids `#mstrip #ms-route #ms-date #mbar #mbar-total #mbar-amt #mbar-cta #mbar-scrim`; classes `.js-mbar` (body), `.open` (aside), `.mbar.kb`, `.mbar.sheet-open`, `body.mbar-lock` — consumed by Task 3's JS.

- [ ] **Step 1: Add the strip markup** — in `booking.html`, directly AFTER the closing `</div>` of `#psteps` and BEFORE `<div class="layout" id="main-layout">`:

```html
<!-- mobile-only trip context strip (activated by booking.js adding body.js-mbar; inert otherwise) -->
<button type="button" class="mstrip" id="mstrip" aria-haspopup="dialog" aria-controls="summary">
  <span class="ms-route" id="ms-route">—</span>
  <span class="ms-date" id="ms-date"></span>
  <span class="ms-more">Details
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m6 9 6 6 6-6"/></svg>
  </span>
</button>
```

- [ ] **Step 2: Add the bar + scrim markup** — in `booking.html`, directly BEFORE `<div class="ph-overlay" id="ph-overlay">`:

```html
<!-- mobile-only sticky total + CTA bar (activated by booking.js; hidden >=881px) -->
<div class="mbar-scrim" id="mbar-scrim" hidden></div>
<div class="mbar" id="mbar">
  <button type="button" class="mbar-total" id="mbar-total" aria-expanded="false" aria-controls="summary">
    <span class="mt-label">Total</span>
    <b id="mbar-amt">—</b>
    <svg class="mt-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="m18 15-6-6-6 6"/></svg>
  </button>
  <button type="button" class="btn btn-primary btn-lg mbar-cta" id="mbar-cta">Continue</button>
</div>
```

- [ ] **Step 3: Add the CSS.** Replace the existing block at ~line 482-488:

```css
  @media(max-width:880px){
    .layout{gap:18px;margin:24px auto 64px;padding:0 20px}
    .layout > aside{order:-1}
    .summary{max-height:none}
    .summary .s-route{padding:14px 16px}
    .summary .s-body{padding:16px}
  }
```

with (original rules kept for the no-JS fallback; everything new scoped to `body.js-mbar`):

```css
  @media(max-width:880px){
    .layout{gap:18px;margin:24px auto 64px;padding:0 20px}
    .layout > aside{order:-1}                    /* no-JS fallback: legacy layout */
    .summary{max-height:none}
    .summary .s-route{padding:14px 16px}
    .summary .s-body{padding:16px}

    /* ── sticky-bar mode (body.js-mbar added by booking.js) ─────────────── */
    body.js-mbar{padding-bottom:calc(76px + env(safe-area-inset-bottom,0px))} /* room for the bar */
    body.js-mbar .layout{margin-bottom:24px}
    /* the summary aside becomes a bottom sheet */
    body.js-mbar .layout > aside{order:0;position:fixed;left:0;right:0;bottom:0;z-index:120;margin:0;
      transform:translateY(102%);visibility:hidden;transition:transform .28s ease,visibility 0s .28s}
    body.js-mbar .layout > aside.open{transform:translateY(0);visibility:visible;transition:transform .28s ease}
    body.js-mbar .summary{max-height:78dvh;overflow:auto;border-radius:18px 18px 0 0;
      box-shadow:0 -18px 44px -12px rgba(20,40,38,.35)}
    body.js-mbar .summary .s-close{position:absolute;top:10px;right:12px;width:34px;height:34px;border:none;
      border-radius:50%;background:rgba(20,40,38,.08);color:var(--ink);font-size:1.25rem;line-height:1;cursor:pointer;z-index:2}
    /* in-page primary buttons are proxied by the bar (back links stay) */
    body.js-mbar .panel .nav-btns .btn{display:none}
    /* lift the WhatsApp FAB above the bar */
    body.js-mbar .wa-fab{bottom:calc(76px + env(safe-area-inset-bottom,0px))}
    /* context strip */
    body.js-mbar .mstrip{display:flex}
    .mstrip{display:none;align-items:center;gap:10px;width:calc(100% - 40px);max-width:560px;margin:14px auto 0;
      padding:11px 14px;border:1px solid var(--line);border-radius:14px;background:var(--paper);
      font:inherit;text-align:left;cursor:pointer;box-shadow:var(--shadow-s)}
    .mstrip .ms-route{font-weight:700;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1 1 auto}
    .mstrip .ms-date{color:var(--ink-soft);font-size:.85rem;white-space:nowrap;flex:none}
    .mstrip .ms-more{display:inline-flex;align-items:center;gap:3px;color:var(--accent-deep);font-weight:700;font-size:.85rem;flex:none}
    .mstrip .ms-more svg{width:14px;height:14px}
    /* sticky bar */
    body.js-mbar .mbar{display:flex}
    .mbar{display:none;position:fixed;left:0;right:0;bottom:0;z-index:130;align-items:center;gap:12px;
      padding:10px 16px calc(10px + env(safe-area-inset-bottom,0px));background:var(--paper);
      border-top:1px solid var(--line);box-shadow:0 -10px 30px -12px rgba(20,40,38,.25)}
    .mbar[hidden]{display:none!important}
    .mbar.kb,.mbar.sheet-open{display:none!important}
    .mbar-total{display:flex;flex-direction:column;align-items:flex-start;gap:0;border:none;background:none;
      font:inherit;cursor:pointer;padding:2px 6px 2px 0;position:relative}
    .mbar-total .mt-label{font-size:.72rem;font-weight:600;color:var(--ink-soft);display:inline-flex;align-items:center;gap:4px}
    .mbar-total b{font-family:var(--display);font-size:1.35rem;line-height:1.15}
    .mbar-total .mt-chev{width:14px;height:14px;position:absolute;right:-10px;top:4px;color:var(--accent-deep)}
    .mbar-cta{flex:1 1 auto;white-space:normal}
    /* scrim */
    .mbar-scrim{position:fixed;inset:0;z-index:110;background:rgba(20,30,28,.45)}
    .mbar-scrim[hidden]{display:none}
    body.mbar-lock{overflow:hidden}
  }
  /* desktop: the new elements never render */
  @media(min-width:881px){.mstrip,.mbar,.mbar-scrim{display:none!important}}
  @media(prefers-reduced-motion:reduce){
    body.js-mbar .layout > aside{transition:none}
  }
```

- [ ] **Step 4: Run the new spec — still red (JS not wired), but markup/CSS parse**

Run: `cd web-tests && npx playwright test booking-mobile-bar smoke --reporter=list`
Expected: booking-mobile-bar still FAILS (no `js-mbar` class ⇒ strip/bar hidden); smoke spec PASSES (no console errors from the new markup/CSS).

- [ ] **Step 5: Commit**

```bash
git add booking.html
git commit -m "feat: mobile strip + sticky-bar + sheet markup and CSS (inert until JS activates)"
```

---

### Task 3: booking.js activation section (observers + proxy)

**Files:**
- Modify: `booking.js` (append a fenced section at the very end of the file)

**Interfaces:**
- Consumes: Task 2's ids/classes; existing `#summary`, `#sum-total/from/to/name/date`, `.panel.active .nav-btns .btn`, `window.goStep`, `window.step`.
- Produces: body class `js-mbar` (gates all Task 2 CSS).

- [ ] **Step 1: Append the section to booking.js**

```js

/* ── mobile sticky bar + summary sheet ─────────────────────────────────────────
   Observation-only UI shell (spec 2026-07-09-mobile-booking-sticky-bar-design.md):
   the bar's CTA proxies the ACTIVE panel's real primary button and MutationObservers
   mirror #summary text, so pricing/validation/step logic and analytics stay untouched.
   No JS (or missing markup) ⇒ body.js-mbar never applies ⇒ the legacy mobile layout. */
(function(){
  const bar=document.getElementById('mbar'), scrim=document.getElementById('mbar-scrim'),
        strip=document.getElementById('mstrip'), cta=document.getElementById('mbar-cta'),
        totBtn=document.getElementById('mbar-total'), amt=document.getElementById('mbar-amt'),
        msRoute=document.getElementById('ms-route'), msDate=document.getElementById('ms-date'),
        aside=document.querySelector('.layout > aside'), summary=document.getElementById('summary');
  if(!bar||!scrim||!strip||!cta||!totBtn||!amt||!aside||!summary) return;
  document.body.classList.add('js-mbar');

  // sheet close button (only rendered in sheet mode via CSS scoping)
  const closeBtn=document.createElement('button');
  closeBtn.type='button'; closeBtn.className='s-close'; closeBtn.setAttribute('aria-label','Close summary');
  closeBtn.innerHTML='&times;';
  summary.prepend(closeBtn);

  const primaryBtn=()=>document.querySelector('.panel.active .nav-btns .btn');

  // ── CTA proxy: mirror label/accent/disabled of the real button; click forwards to it
  let btnObs=null;
  function syncCta(){
    const b=primaryBtn();
    if(!b){ bar.hidden=true; strip.hidden=true; if(btnObs)btnObs.disconnect(); return; }
    bar.hidden=false; strip.hidden=false;
    cta.textContent=b.textContent;
    cta.disabled=b.disabled;
    const isCta=b.classList.contains('btn-cta');
    cta.classList.toggle('btn-cta',isCta);
    cta.classList.toggle('btn-primary',!isCta);
    if(btnObs) btnObs.disconnect();
    btnObs=new MutationObserver(()=>{ cta.disabled=b.disabled; cta.textContent=b.textContent; });
    btnObs.observe(b,{attributes:true,attributeFilter:['disabled'],childList:true,characterData:true,subtree:true});
  }
  cta.addEventListener('click',()=>{ const b=primaryBtn(); if(b&&!b.disabled) b.click(); });

  // ── info mirror: total into the bar; route + date into the strip
  const txt=id=>{ const el=document.getElementById(id); return el?el.textContent.trim():''; };
  function syncInfo(){
    amt.textContent=txt('sum-total')||'—';
    const from=txt('sum-from'), to=txt('sum-to');
    msRoute.textContent=(from&&to&&from!=='—')?from+' → '+to:(txt('sum-name')||'Your trip');
    const d=txt('sum-date');
    msDate.textContent=(d&&d!=='—')?d:'';
  }
  new MutationObserver(syncInfo).observe(summary,{subtree:true,childList:true,characterData:true});
  // panels toggle .active via goStep — watch class flips to rebind the proxy
  new MutationObserver(syncCta).observe(document.getElementById('main-layout'),
    {subtree:true,attributes:true,attributeFilter:['class']});

  // ── bottom sheet open/close
  function openSheet(){ aside.classList.add('open'); scrim.hidden=false; bar.classList.add('sheet-open');
    totBtn.setAttribute('aria-expanded','true'); document.body.classList.add('mbar-lock'); }
  function closeSheet(){ aside.classList.remove('open'); scrim.hidden=true; bar.classList.remove('sheet-open');
    totBtn.setAttribute('aria-expanded','false'); document.body.classList.remove('mbar-lock'); }
  totBtn.addEventListener('click',()=>{ aside.classList.contains('open')?closeSheet():openSheet(); });
  strip.addEventListener('click',openSheet);
  scrim.addEventListener('click',closeSheet);
  closeBtn.addEventListener('click',closeSheet);
  document.addEventListener('keydown',e=>{ if(e.key==='Escape'&&aside.classList.contains('open')) closeSheet(); });

  // ── keyboard: never cover a focused field with the bar
  document.addEventListener('focusin',e=>{
    if(e.target.matches && e.target.matches('.panel input, .panel textarea, .panel select')) bar.classList.add('kb');
  });
  document.addEventListener('focusout',()=>bar.classList.remove('kb'));

  syncCta(); syncInfo();
})();
```

- [ ] **Step 2: Run the new spec — expect green**

Run: `cd web-tests && npx playwright test booking-mobile-bar --reporter=list`
Expected: all 7 tests PASS. If the "advances the step" test flakes on the CTA rebind, the panel-class observer selector is wrong — verify `#main-layout` exists (it does, `booking.html:521`).

- [ ] **Step 3: Commit**

```bash
git add booking.js
git commit -m "feat: activate mobile sticky bar — CTA proxy + summary sheet via observers"
```

---

### Task 4: Reconcile existing mobile tests + full verification

**Files:**
- Modify: `web-tests/e2e/mobile-ux.spec.js` (two tests pin the old layout)
- Delete: `web-tests/e2e/_mobile-audit.spec.js` (uncommitted diagnostic)

- [ ] **Step 1: Rewrite the "summary before panel" test** — replace the test at `mobile-ux.spec.js:4-16` with:

```js
test('mobile booking shows a compact context strip, not the full summary wall', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await gotoBooking(page, { query: 'mode=private&from=cmb-airport&to=hikkaduwa&price=121&vehicle=car' });
  // compact strip above the panel…
  const strip = await page.locator('#mstrip').boundingBox();
  const panel = await page.locator('.stepcard.panel.active').boundingBox();
  expect(strip).toBeTruthy();
  expect(panel).toBeTruthy();
  expect(strip.y).toBeLessThan(panel.y);
  expect(strip.height).toBeLessThanOrEqual(90);
  // …step content reachable on the first screen, sticky bar carries the total
  expect(panel.y).toBeLessThan(480);
  await expect(page.locator('#mbar-amt')).not.toHaveText('—');
});
```

(Keep the same import style as the file's other tests — check its `gotoBooking` usage/`query` first and mirror it.)

- [ ] **Step 2: Update the gutter test** — in the "primary cards keep a visible edge gutter" test, replace the `#summary` gutter assertions with the strip and bar:

```js
  const strip = await page.locator('#mstrip').boundingBox();
  expect(strip.x).toBeGreaterThanOrEqual(18);
  expect(390 - (strip.x + strip.width)).toBeGreaterThanOrEqual(18);
  const bar = await page.locator('#mbar').boundingBox();
  expect(bar.width).toBeGreaterThanOrEqual(388); // full-bleed bar is intentional
```

- [ ] **Step 3: Delete the diagnostic spec**

```bash
rm web-tests/e2e/_mobile-audit.spec.js
```

- [ ] **Step 4: Full verification (CLAUDE.md gate)**

Run: `cd web-tests && npx vitest run && npx playwright test`
Expected: all unit + all e2e green (22 DB-gated skips are normal).

- [ ] **Step 5: Before/after screenshots for the owner** — capture 390px screenshots of the When and Details steps and attach to the final report:

Run (temp script or manual): `npx playwright test booking-mobile-bar --reporter=list` traces, or a one-off page.screenshot in a scratch spec (do not commit it).

- [ ] **Step 6: Commit + push**

```bash
git add web-tests/e2e/mobile-ux.spec.js
git commit -m "test: reconcile mobile-ux specs with the sticky-bar layout"
git push origin main
```

---

## Self-review notes
- Spec coverage: strip (T2), bar + proxy + visibility rules (T2/T3), sheet reusing #summary (T2/T3), keyboard rule (T3 + test T1), FAB lift (T2 CSS), reduced motion (T2), no-JS fallback (T2 CSS scoping), desktop unchanged (T1 test), existing-test reconciliation (T4), rollout gate (T4).
- The `hidden` attribute on `#mbar`/`#mstrip` is managed only by syncCta's no-primary-button rule (receipt views); initial visibility is CSS-driven (`body.js-mbar` + ≤880px). `.mbar[hidden]{display:none!important}` guards the specificity war.
- Consent banner (z 9999) intentionally overlaps the bar until dismissed — one-time, acceptable.
