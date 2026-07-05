# Analytics & Funnel Instrumentation — Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Instrument the redesigned Ceylon Hop app with Microsoft Clarity + GA4 via the existing `GTM-NL6K22CM` container and a deterministic, code-driven booking funnel (landing → search → results → select → checkout → purchase), with `purchase` gated to production so test bookings never pollute GA4.

**Architecture:** A single inline **analytics snippet** (Consent Mode v2 defaults → GTM loader) plus a tiny **`analytics.js`** helper (`chTrack`/`chIsProd`) are added to every page — via `tools/site-chrome.mjs` for generated pages and inlined into the 13 hand-authored root pages, exactly mirroring the existing `errorBeaconSnippet` pattern. `search.js` and `booking.js` call `window.chTrack(event, params)` at each funnel transition, pushing GA4-shaped events to `dataLayer`; GTM (configured in the UI) turns those into GA4/Clarity/Ads/Meta tags. A small `consent.js` banner flips Consent Mode from denied → granted. **No backend changes in Phase 0** (server-side MP/CAPI is Phase 1).

**Tech Stack:** Vanilla JS (no framework, no build step for the site) · Node ESM generator (`tools/*.mjs`) · Vitest + jsdom (unit, `web-tests/unit/`) · Playwright (e2e, `web-tests/e2e/`) · Google Tag Manager / GA4 / Microsoft Clarity (config in the Google UI).

## Global Constraints

- **One step = one branch = one PR.** Build ONLY what the task says (CLAUDE.md rule 1).
- **Tests first, proven red→green.** Write test, run it to see it FAIL, implement to green, paste evidence in PR (CLAUDE.md rule 2).
- **Front-end is editable** (freeze lifted 2026-07-05). Root `*.html`, `site.css`, front-end `*.js` are all editable. Keep changes scoped and covered by `web-tests/` (CLAUDE.md rule 3).
- **No real external services in tests.** GTM/GA4/Clarity network calls must never be required for a test to pass; `chTrack` is a pure `dataLayer.push` and must be no-op safe (CLAUDE.md rule 4).
- **Leave it green.** `cd web-tests && npm run test:all` (Vitest + Playwright) must pass before any PR merges (CLAUDE.md rule 6).
- **Exact IDs (copy verbatim):** GTM container `GTM-NL6K22CM`; GA4 `G-XEW62ZD7B3`; Microsoft Clarity `qrhbzsb6w8`; Google Ads `AW-16942077888`; Meta Pixel `656008603498739`. Only these **publishable** IDs may appear in front-end code. No API secrets/tokens in the repo or front-end.
- **Currency is `USD`** everywhere (pricing engine is USD). Monetary event values use `calcTotal()` (USD number).
- **Production gate:** `chIsProd()` is true only when `location.hostname` is `ceylonhop.com` or `www.ceylonhop.com`. `purchase` fires only when prod AND a real backend booking exists.
- **Scope boundary — Phase 0 only:** do NOT build server-side Measurement Protocol, Meta CAPI, or Google Ads enhanced conversions. Those are Phase 1 in the spec.

**Files created/modified across the plan:**
- Create: `analytics.js` (chTrack + chIsProd helper)
- Create: `consent.js`, plus consent-banner CSS in `site.css`
- Modify: `tools/site-chrome.mjs` (export `analyticsSnippet`, add to `headAssets`)
- Modify: 13 root HTML pages (inline snippet + `<script src>` includes)
- Modify: `search.js` (search / view_item_list / select_item)
- Modify: `booking.js` (begin_checkout / checkout_step / add_payment_info / payment_initiated / payment_dismissed / payment_failed / reprice_shown / reprice_accepted / purchase)
- Modify: `privacy.html` (disclose analytics cookies)
- Create: `web-tests/unit/analytics-helper.test.js`, `web-tests/unit/analytics-snippet.test.js`, `web-tests/unit/consent.test.js`
- Create: `web-tests/e2e/analytics-funnel.spec.js`
- Create: `docs/analytics/gtm-container-checklist.md` (GTM/GA4 UI config — no code)

---

### Task 1: `analytics.js` — the `chTrack` / `chIsProd` helper

**Files:**
- Create: `analytics.js`
- Test: `web-tests/unit/analytics-helper.test.js`

**Interfaces:**
- Produces: `window.chTrack(event: string, params?: object): void` — pushes `{event, ...params}` onto `window.dataLayer` (creating it if absent); never throws. `window.chIsProd(): boolean` — true only for the apex/www host.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/analytics-helper.test.js`:

```js
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(__dirname, '..', '..');
const src = readFileSync(join(ROOT, 'analytics.js'), 'utf8');

// analytics.js is a tiny browser IIFE; eval it against a fake window per test.
function loadInto(win) {
  const fn = new Function('window', 'location', src);
  fn(win, win.location);
  return win;
}

describe('chTrack', () => {
  let win;
  beforeEach(() => { win = { location: { hostname: 'ceylonhop.com' } }; loadInto(win); });

  it('creates dataLayer and pushes {event, ...params}', () => {
    win.chTrack('purchase', { value: 42, currency: 'USD' });
    expect(win.dataLayer).toEqual([{ event: 'purchase', value: 42, currency: 'USD' }]);
  });

  it('works with no params', () => {
    win.chTrack('begin_checkout');
    expect(win.dataLayer[0]).toEqual({ event: 'begin_checkout' });
  });

  it('never throws even if dataLayer.push is hostile', () => {
    win.dataLayer = { push() { throw new Error('boom'); } };
    expect(() => win.chTrack('x')).not.toThrow();
  });
});

describe('chIsProd', () => {
  const at = (hostname) => { const w = { location: { hostname } }; loadInto(w); return w.chIsProd(); };
  it('true on apex and www', () => {
    expect(at('ceylonhop.com')).toBe(true);
    expect(at('www.ceylonhop.com')).toBe(true);
  });
  it('false on Pages / localhost / previews', () => {
    expect(at('ceylonhop.github.io')).toBe(false);
    expect(at('localhost')).toBe(false);
    expect(at('127.0.0.1')).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/analytics-helper.test.js`
Expected: FAIL — `ENOENT ... analytics.js` (file does not exist yet).

- [ ] **Step 3: Write minimal implementation**

Create `analytics.js`:

```js
/* Ceylon Hop — analytics helper. Pushes GA4-shaped events to the GTM dataLayer.
   Fully no-op safe: if GTM/dataLayer is absent (tests, local dev, consent denied)
   the push is harmless and never throws. No IDs or secrets live here. */
(function (window) {
  window.dataLayer = window.dataLayer || [];
  window.chTrack = function (event, params) {
    try {
      window.dataLayer.push(Object.assign({ event: event }, params || {}));
    } catch (e) { /* analytics must never break the page */ }
  };
  // Production only: apex or www. Keeps sandbox/Pages/localhost out of GA4.
  window.chIsProd = function () {
    return /^(www\.)?ceylonhop\.com$/.test(window.location.hostname);
  };
})(window);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/analytics-helper.test.js`
Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add analytics.js web-tests/unit/analytics-helper.test.js
git commit -m "feat(analytics): chTrack + chIsProd helper (no-op safe, prod-gated)"
```

---

### Task 2: Shared analytics snippet in `site-chrome.mjs` (generated pages)

**Files:**
- Modify: `tools/site-chrome.mjs` (add `export const analyticsSnippet`, extend `headAssets`)
- Test: `web-tests/unit/analytics-snippet.test.js`

**Interfaces:**
- Consumes: `analytics.js` from Task 1 (referenced by `<script src>`).
- Produces: `analyticsSnippet` (exported string) and its inclusion in `headAssets(p)` output. The snippet contains: `gtag('consent','default', {...denied})` then the GTM loader for `GTM-NL6K22CM`, then `<script src="${p}analytics.js">`.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/analytics-snippet.test.js`:

```js
import { describe, it, expect } from 'vitest';
import { headAssets, analyticsSnippet } from '../../tools/site-chrome.mjs';

describe('analytics snippet (Phase 0)', () => {
  it('sets Consent Mode v2 defaults to denied before GTM loads', () => {
    // consent default must appear BEFORE the GTM loader in the string
    const iConsent = analyticsSnippet.indexOf("consent','default'");
    const iGtm = analyticsSnippet.indexOf('GTM-NL6K22CM');
    expect(iConsent).toBeGreaterThan(-1);
    expect(iGtm).toBeGreaterThan(-1);
    expect(iConsent).toBeLessThan(iGtm);
  });

  it('denies ad + analytics storage by default', () => {
    expect(analyticsSnippet).toContain("analytics_storage:'denied'");
    expect(analyticsSnippet).toContain("ad_storage:'denied'");
    expect(analyticsSnippet).toContain("ad_user_data:'denied'");
    expect(analyticsSnippet).toContain("ad_personalization:'denied'");
  });

  it('loads the GTM container and the analytics helper via headAssets (with path prefix)', () => {
    const out = headAssets('../');
    expect(out).toContain('GTM-NL6K22CM');
    expect(out).toContain('src="../analytics.js"');
    expect(out).toContain('src="../consent.js"');
  });

  it('carries no API secrets — only publishable IDs', () => {
    expect(analyticsSnippet).not.toMatch(/secret|token|api_secret/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js`
Expected: FAIL — `analyticsSnippet` is not exported (undefined) / `headAssets` output lacks GTM.

- [ ] **Step 3: Write minimal implementation**

In `tools/site-chrome.mjs`, add the export right after the `errorBeaconSnippet` block (after line ~52):

```js
// Phase 0 analytics: Consent Mode v2 defaults (deny until the banner grants) then the
// GTM loader. GA4 + Clarity + Ads + Meta are all tags configured INSIDE GTM-NL6K22CM
// (see docs/analytics/gtm-container-checklist.md) — no per-tag code lives in the repo.
export const analyticsSnippet = `<script>
window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',wait_for_update:500});
</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-NL6K22CM');</script>`;
```

Then extend `headAssets(p)` to include the snippet and the two helper scripts (keep the existing meta/favicon/css/errorBeacon lines):

```js
export function headAssets(p) {
  return `<meta name="theme-color" content="#0AB9B6">
<link rel="icon" href="${p}favicon.svg">
<link rel="stylesheet" href="${p}site.css">
${analyticsSnippet}
<script src="${p}analytics.js"></script>
<script src="${p}consent.js" defer></script>
${errorBeaconSnippet}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js`
Expected: PASS.

Also run the existing generator/beacon guards to confirm no regression:
Run: `cd web-tests && npx vitest run unit/seo-error-beacon.test.js unit/seo-generate.test.js`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add tools/site-chrome.mjs web-tests/unit/analytics-snippet.test.js
git commit -m "feat(analytics): consent-mode + GTM snippet in site-chrome headAssets"
```

---

### Task 3: Inline the snippet + helper scripts into the 13 root pages

**Files:**
- Modify: `index.html`, `booking.html`, `search.html`, `plan.html`, `about.html`, `blog.html`, `why.html`, `tours.html`, `tour.html`, `manage.html`, `privacy.html`, `terms.html`, `404.html`
- Test: `web-tests/unit/analytics-snippet.test.js` (extend from Task 2)

**Interfaces:**
- Consumes: `analyticsSnippet` string / GTM id from Task 2.
- Produces: every root page contains the GTM container id, the consent default, and `analytics.js` + `consent.js` includes — asserted by the guard test (mirrors `seo-error-beacon.test.js`).

- [ ] **Step 1: Write the failing test** (append to `web-tests/unit/analytics-snippet.test.js`)

```js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const ROOT = join(__dirname, '..', '..');
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const PAGES = ['index.html','booking.html','search.html','plan.html','about.html','blog.html','why.html','tours.html','tour.html','manage.html','privacy.html','terms.html','404.html'];

describe('analytics snippet present on every root page', () => {
  it('has GTM + consent default + helper includes on all 13 pages', () => {
    for (const p of PAGES) {
      const html = read(p);
      expect(html.includes('GTM-NL6K22CM'), `${p} missing GTM`).toBe(true);
      expect(html.includes("consent','default'"), `${p} missing consent default`).toBe(true);
      expect(html.includes('analytics.js'), `${p} missing analytics.js`).toBe(true);
      expect(html.includes('consent.js'), `${p} missing consent.js`).toBe(true);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js`
Expected: FAIL — pages missing `GTM-NL6K22CM`.

- [ ] **Step 3: Implement — inline the block into each page's `<head>`**

In EACH of the 13 files, insert this block in `<head>` immediately **before** the existing error-beacon `<script>` (search each file for `errors/client` to locate it; the block goes just above that `<script>`). Paste verbatim (root pages use no path prefix):

```html
<script>
window.dataLayer=window.dataLayer||[];function gtag(){dataLayer.push(arguments);}
gtag('consent','default',{ad_storage:'denied',analytics_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',wait_for_update:500});
</script>
<script>(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','GTM-NL6K22CM');</script>
<script src="analytics.js"></script>
<script src="consent.js" defer></script>
```

Note: `analytics.js` loads **synchronously** (no `defer`) so `window.chTrack` exists before `booking.js`/`search.js` run at end-of-body.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js`
Expected: PASS (all 13 pages).

- [ ] **Step 5: Commit**

```bash
git add *.html web-tests/unit/analytics-snippet.test.js
git commit -m "feat(analytics): inline GTM/consent snippet + helper includes on all root pages"
```

---

### Task 4: Consent Mode v2 banner (`consent.js` + `site.css`)

**Files:**
- Create: `consent.js`
- Modify: `site.css` (append banner styles)
- Test: `web-tests/unit/consent.test.js`

**Interfaces:**
- Consumes: global `gtag` (defined in the snippet) and `localStorage`.
- Produces: on Accept → `gtag('consent','update',{...granted})` + `localStorage['ceylonhop_consent']='granted'`; on Reject → stores `'denied'`; a prior `'granted'` replays the update on load without showing the banner.

- [ ] **Step 1: Write the failing test**

Create `web-tests/unit/consent.test.js`:

```js
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const src = readFileSync(join(__dirname, '..', '..', 'consent.js'), 'utf8');

function makeDom() {
  const store = {};
  const body = { _html: '', insertAdjacentHTML(_, h){ this._html += h; }, querySelector(){ return null; } };
  const listeners = {};
  return {
    localStorage: { getItem: k => (k in store ? store[k] : null), setItem: (k,v)=>{store[k]=String(v);} },
    calls: [],
    gtag: function(){ /* set below */ },
    document: {
      body,
      readyState: 'complete',
      addEventListener(ev,cb){ (listeners[ev]=listeners[ev]||[]).push(cb); },
      // minimal element factory for the banner buttons
      getElementById: () => null,
    },
    _store: store,
  };
}
function run(win){ new Function('window','document','localStorage', src)(win, win.document, win.localStorage); }

describe('consent banner', () => {
  let win;
  beforeEach(() => {
    win = makeDom();
    win.gtag = vi.fn();
    win.location = { hostname: 'ceylonhop.com' };
  });

  it('with no prior choice, defaults stay denied (no consent update on load)', () => {
    run(win);
    expect(win.gtag).not.toHaveBeenCalledWith('consent', 'update', expect.anything());
  });

  it('with a stored grant, replays granted on load and does not render the banner', () => {
    win._store['ceylonhop_consent'] = 'granted';
    run(win);
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ analytics_storage: 'granted' }));
    expect(win.document.body._html).toBe(''); // banner not injected
  });

  it('exposes chConsent(choice) that stores and updates', () => {
    run(win);
    win.chConsent('granted');
    expect(win._store['ceylonhop_consent']).toBe('granted');
    expect(win.gtag).toHaveBeenCalledWith('consent', 'update', expect.objectContaining({ ad_storage: 'granted' }));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/consent.test.js`
Expected: FAIL — `consent.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `consent.js`:

```js
/* Ceylon Hop — Consent Mode v2 banner. Defaults are 'denied' (set in the head snippet);
   this grants on Accept and remembers the choice. No third-party CMP. */
(function (window, document, localStorage) {
  var KEY = 'ceylonhop_consent';
  var GRANT = { ad_storage: 'granted', analytics_storage: 'granted', ad_user_data: 'granted', ad_personalization: 'granted' };
  function gtag(){ (window.dataLayer = window.dataLayer || []).push(arguments); }

  window.chConsent = function (choice) {
    try { localStorage.setItem(KEY, choice); } catch (e) {}
    if (choice === 'granted') gtag('consent', 'update', GRANT);
    var el = document.getElementById('ch-consent'); if (el && el.remove) el.remove();
  };

  var prior = null;
  try { prior = localStorage.getItem(KEY); } catch (e) {}
  if (prior === 'granted') { gtag('consent', 'update', GRANT); return; }
  if (prior === 'denied') return; // respect a prior reject, no banner

  function render() {
    document.body.insertAdjacentHTML('beforeend',
      '<div id="ch-consent" class="ch-consent" role="dialog" aria-label="Cookie consent">' +
        '<p>We use cookies for analytics to improve your trip planning. ' +
        '<a href="/privacy.html">Learn more</a>.</p>' +
        '<div class="ch-consent-btns">' +
          '<button type="button" class="btn btn-sm" onclick="chConsent(\'denied\')">Reject</button>' +
          '<button type="button" class="btn btn-cta btn-sm" onclick="chConsent(\'granted\')">Accept</button>' +
        '</div>' +
      '</div>');
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', render);
  else render();
})(window, document, window.localStorage);
```

Append to `site.css`:

```css
/* Consent banner (Phase 0 analytics) */
.ch-consent{position:fixed;left:16px;right:16px;bottom:16px;z-index:9999;max-width:520px;margin:0 auto;
  background:var(--white,#fff);border:1px solid var(--line,#e5e7eb);border-radius:14px;
  box-shadow:var(--shadow-lg,0 10px 40px rgba(0,0,0,.18));padding:14px 16px;
  display:flex;gap:12px;align-items:center;flex-wrap:wrap;font-size:.9rem}
.ch-consent p{margin:0;flex:1 1 240px}
.ch-consent-btns{display:flex;gap:8px;margin-left:auto}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/consent.test.js`
Expected: PASS (3 assertions).

- [ ] **Step 5: Commit**

```bash
git add consent.js site.css web-tests/unit/consent.test.js
git commit -m "feat(analytics): Consent Mode v2 banner (grant on accept, remember choice)"
```

---

### Task 5: Instrument `search.js` — `search`, `view_item_list`, `select_item`

**Files:**
- Modify: `search.js` (after the results render at line ~187)
- Test: `web-tests/e2e/analytics-funnel.spec.js` (created here, extended in Tasks 6–7)

**Interfaces:**
- Consumes: `window.chTrack` (Task 1); existing `fromId`, `toId`, `pax`, `quote` (`{car, van}`), `shared` (`{seat}` or null), `fromP`, `toP` in `search.js` scope.
- Produces: three `dataLayer` events on the search page — `search`, then `view_item_list`, then `select_item` on CTA click.

- [ ] **Step 1: Write the failing e2e test**

Create `web-tests/e2e/analytics-funnel.spec.js` (Playwright serves the static site per the existing `playwright.config.js`):

```js
import { test, expect } from '@playwright/test';

// Capture dataLayer events pushed before/after load.
async function events(page) {
  return page.evaluate(() => (window.dataLayer || []).filter(e => e && e.event).map(e => e.event));
}

test.describe('search funnel events', () => {
  test('search + view_item_list fire on the results page', async ({ page }) => {
    await page.goto('/search.html?from=kandy&to=ella&pax=2');
    await page.waitForSelector('#results .opt');
    const evs = await events(page);
    expect(evs).toContain('search');
    expect(evs).toContain('view_item_list');
  });

  test('select_item fires when a Select CTA is clicked', async ({ page }) => {
    await page.goto('/search.html?from=kandy&to=ella&pax=2');
    await page.waitForSelector('#results .opt-private a.btn');
    // don't navigate away — assert the event was queued on click
    await page.evaluate(() => {
      const a = document.querySelector('#results .opt-private a.btn');
      a.addEventListener('click', e => e.preventDefault(), { capture: true });
      a.click();
    });
    const evs = await events(page);
    expect(evs).toContain('select_item');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx playwright test analytics-funnel`
Expected: FAIL — `search` / `view_item_list` / `select_item` absent from `dataLayer`.

- [ ] **Step 3: Implement in `search.js`** — insert immediately **after** the results-render line (`document.getElementById('results').innerHTML = ...`, ~line 188):

```js
// ---- funnel: search + results view (Phase 0 analytics) ----
(function () {
  if (typeof window.chTrack !== 'function') return;
  var listId = fromId + '_' + toId;
  var items = [
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'car', price: quote.car, quantity: pax },
    { item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'private', item_variant: 'van', price: quote.van, quantity: pax }
  ];
  if (shared) items.push({ item_id: fromId + '_' + toId, item_name: fromP.name + ' → ' + toP.name, item_category: 'shared', item_variant: 'seat', price: shared.seat, quantity: pax });

  window.chTrack('search', { from: fromId, to: toId, pax: pax, source: 'search' });
  window.chTrack('view_item_list', { item_list_id: listId, currency: 'USD', items: items });

  // select_item: delegate on the results container; read mode/vehicle from the CTA href.
  var box = document.getElementById('results');
  if (box) box.addEventListener('click', function (e) {
    var a = e.target && e.target.closest ? e.target.closest('a[href*="booking.html"]') : null;
    if (!a) return;
    var q = new URLSearchParams(a.getAttribute('href').split('?')[1] || '');
    window.chTrack('select_item', { item_list_id: listId, mode: q.get('mode') || '', item_variant: q.get('vehicle') || 'seat' });
  }, true); // capture: fires before navigation starts
})();
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx playwright test analytics-funnel`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add search.js web-tests/e2e/analytics-funnel.spec.js
git commit -m "feat(analytics): search/view_item_list/select_item events on results page"
```

---

### Task 6: Instrument `booking.js` — checkout funnel (no purchase yet)

**Files:**
- Modify: `booking.js` — init block (~line 1290), `goStep` wrapper (~1294), `setPayPlan` (line 720), `runPayment` (line 1059), `showPayDismissed`/`showPayFailed` (1151–1156), `acceptReprice` (657) and the reprice-note render (~638)
- Test: `web-tests/e2e/analytics-funnel.spec.js` (extend)

**Interfaces:**
- Consumes: `window.chTrack` (Task 1); existing `calcTotal()`, `state.payPlan`, `state.ad/ch/bags`, `isTrip`, `r.stops`, `state.pendingReprice`.
- Produces: `begin_checkout` (load), `checkout_step` (forward step advance), `add_payment_info` (plan chosen), `payment_initiated` (runPayment), `payment_dismissed`, `payment_failed`, `reprice_shown`, `reprice_accepted`.

- [ ] **Step 1: Write the failing e2e test** (append to `analytics-funnel.spec.js`)

```js
test.describe('booking checkout funnel events', () => {
  test('begin_checkout fires on booking load', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    await page.waitForSelector('.panel');
    const evs = await page.evaluate(() => (window.dataLayer || []).map(e => e && e.event));
    expect(evs).toContain('begin_checkout');
  });

  test('add_payment_info fires when a pay plan is chosen', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    await page.waitForFunction(() => typeof window.setPayPlan === 'function');
    await page.evaluate(() => window.setPayPlan('full'));
    const evs = await page.evaluate(() => (window.dataLayer || []).map(e => e && e.event));
    expect(evs).toContain('add_payment_info');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx playwright test analytics-funnel -g "checkout funnel"`
Expected: FAIL — `begin_checkout` / `add_payment_info` absent.

- [ ] **Step 3: Implement the event calls**

**(a) `begin_checkout`** — in the init block, immediately after `render(); checkWhere(); renderRouteMap();` (~line 1290):

```js
// funnel: entering the booking flow (Phase 0 analytics)
if (typeof window.chTrack === 'function') {
  window.chTrack('begin_checkout', {
    currency: 'USD', value: calcTotal(),
    mode: isTrip ? 'trip' : (r && r.type === 'shared' ? 'shared' : 'private'),
    route: (r && r.stops) ? r.stops[0] + '→' + r.stops[r.stops.length - 1] : ''
  });
}
```

**(b) `checkout_step`** — extend the existing `goStep` wrapper (~line 1294). Replace:

```js
  window.goStep=function(n){ maxStep=Math.max(maxStep,n); _go(n); paintSteps(); };
```

with:

```js
  var STEP_NAME = { 1: 'when', 2: 'where', 3: isTrip ? 'service' : 'pax', 4: 'payment' };
  window.goStep=function(n){
    var advanced = n > maxStep;                 // only a genuine forward move counts
    maxStep=Math.max(maxStep,n); _go(n); paintSteps();
    if (advanced && typeof window.chTrack === 'function' && STEP_NAME[n]) {
      window.chTrack('checkout_step', { step: n, name: STEP_NAME[n] });
    }
  };
```

**(c) `add_payment_info`** — in `window.setPayPlan` (line 720), append a `chTrack` call:

```js
window.setPayPlan=function(plan){ state.payPlan=plan; document.querySelectorAll('.pc-opt').forEach(o=>o.classList.toggle('on',o.dataset.plan===plan)); render();
  if(typeof window.chTrack==='function') window.chTrack('add_payment_info',{payment_type:plan,currency:'USD',value:calcTotal()}); };
```

**(d) `payment_initiated`** — at the top of `runPayment()` (line 1059, just inside the function):

```js
  if(typeof window.chTrack==='function') window.chTrack('payment_initiated',{payment_type:state.payPlan,currency:'USD',value:calcTotal()});
```

**(e) `payment_dismissed` / `payment_failed`** — first line inside each handler (lines 1151–1156):

```js
function showPayFailed(){
  if(typeof window.chTrack==='function') window.chTrack('payment_failed',{});
  phShowEnd('error','Your payment didn’t go through — no charge was made. Please try again.');
}
function showPayDismissed(){
  if(typeof window.chTrack==='function') window.chTrack('payment_dismissed',{});
  phShowEnd('cancelled','Payment cancelled — your booking isn’t confirmed yet. You can try again when you’re ready.');
}
```

**(f) `reprice_shown` / `reprice_accepted`** — in `acceptReprice()` (line 657) add after `state.pendingReprice=null;` (line 659):

```js
  if(typeof window.chTrack==='function') window.chTrack('reprice_accepted',{extra_km:p.extraKm,new_value:calcTotal()});
```

And where the reprice is first surfaced — at the point `state.pendingReprice = { km, extraKm: dec.extraKm, ... }` is set (~line 296), add immediately after that assignment:

```js
        if(typeof window.chTrack==='function') window.chTrack('reprice_shown',{extra_km:dec.extraKm});
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx playwright test analytics-funnel -g "checkout funnel"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add booking.js web-tests/e2e/analytics-funnel.spec.js
git commit -m "feat(analytics): checkout funnel events in booking.js (steps, payment, reprice)"
```

---

### Task 7: Prod-gated `purchase` in `finalizeBooking`

**Files:**
- Modify: `booking.js` — `finalizeBooking(apiBooking)` (line 1234)
- Test: `web-tests/e2e/analytics-funnel.spec.js` (extend)

**Interfaces:**
- Consumes: `window.chTrack`, `window.chIsProd` (Task 1); `apiBooking.reference`, `calcTotal()`, `state.payPlan`.
- Produces: a single `purchase` event **only** when `chIsProd()` AND a real backend booking (`apiBooking`) exists. `transaction_id = apiBooking.reference`.

- [ ] **Step 1: Write the failing e2e test** (append)

```js
test.describe('purchase gating', () => {
  test('purchase does NOT fire on non-prod host (localhost) even after finalize', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    await page.waitForFunction(() => typeof window.chIsProd === 'function');
    // sanity: the test host is not prod
    expect(await page.evaluate(() => window.chIsProd())).toBe(false);
    // simulate a completed real booking
    await page.evaluate(() => window.finalizeBooking && window.finalizeBooking({ reference: 'CH-TEST-2026' }));
    const evs = await page.evaluate(() => (window.dataLayer || []).map(e => e && e.event));
    expect(evs).not.toContain('purchase');
  });

  test('purchase fires once when prod + real booking (chIsProd stubbed true)', async ({ page }) => {
    await page.goto('/booking.html?mode=private&from=kandy&to=ella&pax=2');
    await page.waitForFunction(() => typeof window.finalizeBooking === 'function');
    await page.evaluate(() => {
      window.chIsProd = () => true;                     // stub prod
      window.finalizeBooking({ reference: 'CH-REAL-2026' });
    });
    const purchases = await page.evaluate(() =>
      (window.dataLayer || []).filter(e => e && e.event === 'purchase'));
    expect(purchases.length).toBe(1);
    expect(purchases[0].transaction_id).toBe('CH-REAL-2026');
  });
});
```

Note: `finalizeBooking` and `goStep`/`setPayPlan` must be reachable from the page. `goStep`/`setPayPlan` are already on `window`; expose `finalizeBooking` in Step 3 by assigning `window.finalizeBooking = finalizeBooking;`.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx playwright test analytics-funnel -g "purchase gating"`
Expected: FAIL — `window.finalizeBooking` undefined / no `purchase` event.

- [ ] **Step 3: Implement**

In `finalizeBooking(apiBooking)` (line 1234), add the event just before the final `return true;` (~line 1266):

```js
  // funnel: purchase — PROD only, and only for a real backend booking, so sandbox/demo
  // and pre-cutover Pages traffic never pollute GA4 revenue. Deduped later (Phase 1) by ref.
  if (apiBooking && typeof window.chTrack === 'function' && typeof window.chIsProd === 'function' && window.chIsProd()) {
    window.chTrack('purchase', {
      transaction_id: apiBooking.reference,
      currency: 'USD', value: calcTotal(),
      payment_type: state.payPlan
    });
  }
```

And expose the function for the flow/tests — add after the function definition (after its closing brace, ~line 1267):

```js
window.finalizeBooking = finalizeBooking;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx playwright test analytics-funnel -g "purchase gating"`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add booking.js web-tests/e2e/analytics-funnel.spec.js
git commit -m "feat(analytics): prod-gated purchase event on booking finalize"
```

---

### Task 8: `privacy.html` — disclose analytics cookies

**Files:**
- Modify: `privacy.html`
- Test: `web-tests/unit/analytics-snippet.test.js` (add one assertion)

**Interfaces:**
- Produces: privacy copy mentioning analytics/cookies + how to opt out, satisfying the Consent Mode disclosure requirement.

- [ ] **Step 1: Write the failing test** (append to `analytics-snippet.test.js`)

```js
describe('privacy disclosure', () => {
  it('privacy.html mentions analytics cookies and opt-out', () => {
    const html = read('privacy.html').toLowerCase();
    expect(html).toContain('analytics');
    expect(html).toContain('cookie');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js -t "privacy disclosure"`
Expected: FAIL — privacy.html has no analytics/cookie copy.

- [ ] **Step 3: Implement** — add a bullet to the existing privacy list in `privacy.html` (match the surrounding markup; it is a short bulleted list):

```html
<li>We use cookies and third-party analytics (Google Analytics and Microsoft Clarity) to understand how visitors use the site and improve it. These are off by default until you accept them in the cookie banner, and you can decline at any time without affecting your booking.</li>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd web-tests && npx vitest run unit/analytics-snippet.test.js -t "privacy disclosure"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add privacy.html web-tests/unit/analytics-snippet.test.js
git commit -m "docs(privacy): disclose GA4 + Clarity analytics cookies and opt-out"
```

---

### Task 9: GTM container configuration checklist (UI, no code)

**Files:**
- Create: `docs/analytics/gtm-container-checklist.md`

This task produces the click-by-click steps for configuring `GTM-NL6K22CM` and the GA4 property in the Google UI. It has **no code and no automated test** — it is the human/browser runbook that activates the tags the code now feeds. It is a separate task because it gates go-live but cannot be unit-tested.

- [ ] **Step 1: Write the checklist**

Create `docs/analytics/gtm-container-checklist.md`:

```markdown
# GTM-NL6K22CM — Phase 0 configuration checklist

Do this in the Google Tag Manager + GA4 web UI. The site code already pushes all events
below to `dataLayer`; these steps turn them into tags. Reuse the EXISTING container/property.

## GA4
- [ ] GA4 Configuration tag → Measurement ID `G-XEW62ZD7B3`, trigger: Consent Initialization.
- [ ] Mark `purchase` as a **key event** (Admin → Events).
- [ ] Register custom dimensions (event-scoped): `payment_type`, `name` (checkout step),
      `item_category`, `source`, `mode`.

## GA4 event tags (one per dataLayer event; Custom Event trigger on the event name)
- [ ] `search`, `view_item_list`, `select_item`, `begin_checkout`, `checkout_step`,
      `add_payment_info`, `payment_initiated`, `purchase`, `payment_dismissed`,
      `payment_failed`, `reprice_shown`, `reprice_accepted`.
- [ ] Map event params via Data Layer Variables (value, currency, items, payment_type, step…).

## Microsoft Clarity
- [ ] Add the Microsoft Clarity tag (Community template) → project `qrhbzsb6w8`,
      trigger: All Pages (respecting consent). Verify replays appear in Clarity.

## Consent
- [ ] Enable Consent Mode; confirm all tags have "Require additional consent" =
      `analytics_storage` / `ad_storage` as appropriate. Defaults are set in the page head.

## Deferred to Phase 1 (do NOT configure yet)
- [ ] Google Ads `AW-16942077888` conversion on `purchase`.
- [ ] Meta Pixel `656008603498739` base + Purchase.
- [ ] Server-side Measurement Protocol / Meta CAPI.

## Verify
- [ ] GTM Preview (Tag Assistant) → walk the funnel on the live app → each event shows.
- [ ] GA4 DebugView → funnel events arrive with params.
- [ ] Build a Funnel Exploration: page_view → search → view_item_list → select_item →
      begin_checkout → checkout_step → add_payment_info → payment_initiated → purchase.
```

- [ ] **Step 2: Commit**

```bash
git add docs/analytics/gtm-container-checklist.md
git commit -m "docs(analytics): GTM/GA4 Phase 0 configuration checklist"
```

---

### Task 10: Full green + branch wrap-up

**Files:** none (verification only)

- [ ] **Step 1: Run the full suite**

Run: `cd web-tests && npm run test:all`
Expected: PASS — all Vitest unit tests (incl. `analytics-helper`, `analytics-snippet`, `consent`) and all Playwright e2e (incl. `analytics-funnel`) green. If any pre-existing test broke, fix it before proceeding.

- [ ] **Step 2: Confirm no secrets leaked to the front-end**

Run: `grep -rInE "secret|_token|api_secret|MERCHANT_SECRET" analytics.js consent.js *.html | grep -vi errors/client || echo "clean"`
Expected: `clean` (only publishable IDs are present in front-end files).

- [ ] **Step 3: Push the branch and open a PR**

```bash
git push -u origin analytics-funnel-instrumentation
gh pr create --title "Analytics & funnel instrumentation (Phase 0)" \
  --body "Ports GTM-NL6K22CM + Clarity onto the redesigned app and adds the end-to-end booking funnel (search → view_item_list → select_item → begin_checkout → checkout_step → add_payment_info → payment_initiated → purchase). purchase is prod-gated. Consent Mode v2 banner + privacy disclosure. Server-side conversions are Phase 1. Spec: docs/superpowers/specs/2026-07-05-analytics-funnel-instrumentation-design.md"
```

---

## Self-review notes

- **Spec coverage:** Phase 0 items all mapped — Clarity (Task 9 + snippet), GA4 + client funnel events (Tasks 1–7), purchase prod-gated (Task 7), Consent Mode v2 + banner (Tasks 2, 4), privacy update (Task 8), ships-with-cutover (prod gate + checklist). Phase 1 items (server MP/CAPI, Ads, Meta) are explicitly deferred and NOT built — correct per the approved scope.
- **Event-name consistency:** `checkout_step` (custom, not the UA-era `checkout_progress`) used consistently across search/booking/tests/checklist. `search` (not `generate_lead`) for the homepage/route lookup. `items[]` shape identical across `view_item_list`/`select_item`/`begin_checkout`/`purchase`.
- **No backend changes:** Phase 0 touches only front-end + docs, so CLAUDE.md's `api/` gate (`npm run check`) is not engaged; `web-tests` `npm run test:all` is the relevant gate.
