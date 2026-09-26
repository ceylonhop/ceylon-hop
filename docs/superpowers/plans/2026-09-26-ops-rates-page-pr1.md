# Ops Rates page — PR 1 (move only) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rate Settings leaves the quote builder and becomes a founder-only **Rates** page in the
ops side menu, showing the same read-only rate card and the same hot-zones panel. No price
changes.

**Architecture:** The ops shell (first `<script>` block of `api/src/routes/ops-ui.html`) gets a
`rates` route (`#rates`), a side-menu item and a `viewRates()` that draws the page header plus a
`#rates-mount` node. The card and hot-zones code stays inside the `QuoteView` module, which already
holds its helpers (`api`, `esc`, `apiPlaces`, `morphdom` options) and its `.qv`-scoped CSS.
`QuoteView` exposes `showRates(el)` / `hideRates()` and diff-renders into the mount. The popup, the
builder's Rates button and their actions are deleted.

**Tech Stack:** a single-file ops UI served by the API (vanilla JS; ES5 inside `QuoteView`, ES2017
in the shell; vendored morphdom), Playwright e2e in `web-tests/`, Vitest in `api/`.

**Spec:** `docs/superpowers/specs/2026-09-26-ops-rates-page-design.md` §4–§5, §10 (PR 1).

## Global Constraints

- Build only PR 1 of the spec: nothing in `api/src/quote/`, no migration, no endpoint, and no
  change to what the rate card or hot zones show or do.
- The page is gated on `margin:view`, the same capability that gated the old builder button.
  Without it, `#rates` silently bounces to the default landing, as `#analytics` does.
- Side-menu order for a founder: Bookings, Quotes, Lookup, Analytics, **Rates**.
- Tests go red first, then green, and the evidence goes in the PR (CLAUDE.md Hard rule 2).
- Leave it green: `cd api && npm run check` and `cd web-tests && npm run test:all` both pass
  before the PR. Read the runner's own summary line and exit code, never a piped tail.
- Work in the worktree
  `/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad/wt-rates`
  on branch `feat/ops-rates-page`, never the shared tree. Stage files by path.
- Line numbers below are from `origin/main` @ `63e738c1`. Match on the quoted text, not the
  number.

---

### Task 1: Rates page in the ops side menu

**Files:**
- Create: `web-tests/e2e/ops-rates-page.spec.js`
- Modify: `web-tests/e2e/ops-lookup.spec.js:84-93` (nav order test)
- Modify: `web-tests/e2e/quote-approval.spec.js:682-706` (builder Rates-button tests)
- Modify: `web-tests/e2e/ops-hotzone-autocomplete.spec.js:1-45` (open the zones via `#rates`)
- Modify: `api/src/routes/ops-ui.html`:
  - CSS after `:907`
  - shell `:2183`, `:2194`, `:2322-2349`, `:3308` (before the lookup submit listener), `:3957-3959`, `:3997-4002`, `:4050-4051`, `:4440`
  - QuoteView `:4658`, `:7581-7650`, after `:7722`, `:9557-9558`, `:9744-9763`, `:10298-10319`, `:10520`, teardown, `:11650`

**Interfaces:**
- Produces: `QuoteView.showRates(el: HTMLElement): void`. It mounts or re-mounts the page into
  `el`; a new `el` refetches the card and zones. Also `QuoteView.hideRates(): void`, which
  unmounts, is idempotent, and makes every later async repaint a no-op.
- Produces (DOM): the side-menu button `[data-testid="rates-nav"][data-route="rates"]`,
  `#view h1` = `Rates`, `#rates-mount > [data-testid="rates-page"].qv.qv-page`, and the existing
  `#hz-place`, `.ch-rate-grid` and `.ch-hz-row` inside it.
- Consumes: the existing `GET /admin/quote/rate-card` and `GET/POST/PATCH/DELETE /admin/quote/zones`,
  `window.opsToast` (set in `bootApp`, `ops-ui.html:4409`), and `window.opsCaps`.

- [ ] **Step 1: Install web-tests dependencies in the worktree**

Run: `cd web-tests && npm ci --no-audit --no-fund`
Expected: exit 0. The Playwright browsers already sit in `~/Library/Caches/ms-playwright`
(chromium-1228).

- [ ] **Step 2: Write the new e2e spec**

Create `web-tests/e2e/ops-rates-page.spec.js`:

```js
import { test, expect } from '@playwright/test';

// Rates page (spec 2026-09-26 §5): Rate Settings leaves the quote builder and becomes a
// founder-only page in the ops side menu. PR 1 moves it as-is — the read-only rate card and the
// hot-zones panel — so these tests pin WHERE it lives and WHO reaches it, not what it prices.
// Offline: whoami, the queue, the quotes list, the rate card and the zone list are stubbed
// (server-side 403s on the zone writes are covered by api's hotZonesRoutes.test.ts).

const OPS_FILE = '/api/src/routes/ops-ui.html';
const json = (o, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(o) });

const FOUNDER = ['quote:manage', 'quote:approve', 'margin:view', 'bookings:operate', 'bookings:read', 'payments:act', 'payments:reverse', 'analytics:view'];
const OPS = ['quote:manage', 'quote:approve_simple', 'bookings:operate', 'bookings:read'];
const FINANCE = ['quote:manage', 'bookings:read', 'payments:act'];

// The GET /admin/quote/rate-card shape (internalQuote.ts `r.get('/rate-card')`), today's values.
const RATE_CARD = {
  version: '2026-07-14',
  perKmCents: { car: 40.25, van: 54.05, van9: 54.05, van14: 55.2, custom: 201.25 },
  floorCents: { car: 2900, van: 4999, van9: 4999, van14: 8500, custom: 11000 },
  chauffeurDayRateCents: 3105,
  bufferPct: 10,
  depositPct: 10,
  extras: { sightseeing: 1000, 'safari-wait': 1900, luggage: 500, front: 800, flex: 1200, waiting: 1000 },
  fxUsdToLkr: 330,
  vehicle: {
    car: { maxPax: 3, maxBags: 3 }, van: { maxPax: 6, maxBags: 6 }, van9: { maxPax: 9, maxBags: 8 },
    van14: { maxPax: 14, maxBags: 12 }, custom: { maxPax: 99, maxBags: 99 },
  },
};
const ZONES = { zones: [{ id: 'z1', placeName: 'Ella', boostPct: 15, active: true }], disabled: false };

// Boots the shell with `caps`. `zones` overrides the zone-list handler (to count or delay it).
async function boot(page, caps, { zones } = {}) {
  await page.addInitScript(() => {
    window.google = {
      accounts: { id: { initialize() {}, renderButton() {}, prompt() {} } },
      maps: {
        Map: function () {}, DirectionsService: function () {}, DirectionsRenderer: function () {},
        TravelMode: { DRIVING: 'DRIVING' }, importLibrary: async () => ({}),
      },
    };
  });
  await page.route('**/admin/**', (r) => r.fulfill(json({})));
  await page.route('**/admin/ops/whoami', (r) => r.fulfill(json({ email: 'x@e2e.test', role: 'x', caps })));
  await page.route('**/admin/ops/bookings', (r) => r.fulfill(json([])));
  await page.route('**/admin/quote/list**', (r) => r.fulfill(json({ quotes: [] })));
  await page.route('**/admin/quote/rate-card', (r) => r.fulfill(json(RATE_CARD)));
  await page.route('**/admin/quote/zones', zones || ((r) => r.fulfill(json(ZONES))));
}
const ready = (page) => page.waitForSelector('#approot:not([hidden]) #nav button', { timeout: 10000 });
const ratesPage = (page) => page.locator('[data-testid="rates-page"]');

test('founder: Rates closes the side menu and opens the rate card with hot zones', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#bookings');
  await ready(page);
  const nav = page.locator('[data-testid="rates-nav"]');
  await expect(nav).toBeVisible();
  await expect(nav).toHaveAttribute('title', 'Rates');
  expect(await page.locator('#nav button').evaluateAll((bs) => bs.map((b) => b.dataset.route)))
    .toEqual(['tickets', 'quotes', 'lookup', 'analytics', 'rates']);

  await nav.click();
  await expect(page.locator('#view h1')).toHaveText('Rates');
  expect(new URL(page.url()).hash).toBe('#rates');
  await expect(nav).toHaveClass(/active/);
  await expect(ratesPage(page)).toBeVisible();
  // The rate card, drawn from GET /admin/quote/rate-card — the numbers the popup showed.
  await expect(ratesPage(page).locator('.ch-rate-group-title').first()).toHaveText(/Per-km rates/i);
  await expect(ratesPage(page)).toContainText('$0.40');
  await expect(ratesPage(page)).toContainText('2026-07-14');
  // The hot-zones panel moved with it: the stubbed zone is listed and the add form is live.
  await expect(ratesPage(page).locator('.ch-hz-row')).toContainText('Ella');
  await expect(page.locator('#hz-place')).toBeVisible();
});

test('founder: a hand-typed #rates opens the page directly', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(page.locator('#view h1')).toHaveText('Rates');
  await expect(ratesPage(page)).toBeVisible();
  await expect(page.locator('[data-testid="rates-nav"]')).toHaveClass(/active/);
});

for (const [role, caps] of [['ops', OPS], ['finance', FINANCE]]) {
  test(`${role}: no Rates item, and a hand-typed #rates bounces silently`, async ({ page }) => {
    let zoneCalls = 0;
    await boot(page, caps, { zones: (r) => { zoneCalls++; return r.fulfill(json(ZONES)); } });
    await page.goto(OPS_FILE + '#rates');
    await ready(page);
    await expect(page.locator('[data-testid="rates-nav"]')).toHaveCount(0);
    await expect(ratesPage(page)).toHaveCount(0);
    expect(new URL(page.url()).hash).not.toBe('#rates');
    expect(zoneCalls).toBe(0);
  });
}

test('a zone list that lands after leaving the page paints nothing', async ({ page }) => {
  let release;
  const gate = new Promise((res) => { release = res; });
  await boot(page, FOUNDER, { zones: async (r) => { await gate; return r.fulfill(json(ZONES)); } });
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(ratesPage(page)).toBeVisible(); // card painted; the zone list is still pending
  await page.locator('#nav [data-route="tickets"]').click();
  await expect(page.locator('#view h1')).toHaveText('Bookings');

  const landed = page.waitForResponse((res) => res.url().includes('/admin/quote/zones'));
  release();
  await landed;
  await page.evaluate(() => new Promise((r) => setTimeout(r, 50))); // let its handler run
  await expect(ratesPage(page)).toHaveCount(0);
  await expect(page.locator('#view h1')).toHaveText('Bookings');
});

test('phone width: the page fits the screen and the card stacks to one column', async ({ page }) => {
  await page.setViewportSize({ width: 375, height: 812 });
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#rates');
  await ready(page);
  await expect(ratesPage(page).locator('.ch-hz-row')).toContainText('Ella');
  const overflow = await page.evaluate(() => {
    const v = document.querySelector('#view');
    return {
      page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      view: v.scrollWidth - v.clientWidth,
    };
  });
  expect(overflow.page).toBeLessThanOrEqual(0);
  expect(overflow.view).toBeLessThanOrEqual(0);
  const cols = await ratesPage(page).locator('.ch-rate-grid')
    .evaluate((g) => getComputedStyle(g).gridTemplateColumns.split(' ').length);
  expect(cols).toBe(1);
});
```

- [ ] **Step 3: Update the three existing specs that assumed the popup**

In `web-tests/e2e/ops-lookup.spec.js`, replace:

```js
  await expect(page.locator('#nav button')).toHaveCount(4);
  expect(await page.locator('#nav button').evaluateAll((bs) => bs.map((b) => b.dataset.route)))
    .toEqual(['tickets', 'quotes', 'lookup', 'analytics']);
```

with:

```js
  // FOUNDER holds margin:view, so Rates (spec 2026-09-26) closes the list.
  await expect(page.locator('#nav button')).toHaveCount(5);
  expect(await page.locator('#nav button').evaluateAll((bs) => bs.map((b) => b.dataset.route)))
    .toEqual(['tickets', 'quotes', 'lookup', 'analytics', 'rates']);
```

In `web-tests/e2e/quote-approval.spec.js`, replace the whole block from
`// ── Margin + Rates are founder-only across the detail view` through the closing `}` of the
`for (const role of ['ops', 'finance'])` loop with:

```js
// ── Margin is founder-only across the detail view; Rates left the builder ────────────
// Rates moved to its own side-menu page (spec 2026-09-26 §5); its access tests live in
// ops-rates-page.spec.js. Here: the builder carries no Rates button or popup for anyone.
test('founder sees the estimated margin, and the builder has no Rates button', async ({ page }) => {
  await openDetail(page, 'founder', { id: 'q1', status: 'draft' });
  await expect(page.locator('.ch-margin')).toContainText(/Est\. margin/i);
  await expect(page.locator('#btnRates')).toHaveCount(0);
  await expect(page.locator('#quoteRoot [data-action="openRates"]')).toHaveCount(0);
  await expect(page.locator('[data-testid="rates-nav"]')).toBeVisible();
});

for (const role of ['ops', 'finance']) {
  test(`${role} never sees margin/profit or a way to the rates`, async ({ page }) => {
    await openDetail(page, role, { id: 'q1', status: 'draft' });
    // No margin anywhere in the builder (money pane or internal tab).
    await expect(page.locator('.ch-margin')).toHaveCount(0);
    await page.locator('.ch-tab[data-tab="internal"]').click();
    await expect(page.locator('#quoteRoot .ch-app')).not.toContainText(/margin/i);
    // No Rates button in the builder, and no Rates item in the side menu.
    await expect(page.locator('#btnRates')).toHaveCount(0);
    await expect(page.locator('[data-testid="rates-nav"]')).toHaveCount(0);
  });
}
```

In `web-tests/e2e/ops-hotzone-autocomplete.spec.js`:
- In the header comment, change `Covers the Rate-Settings "Hot zones" town field` to
  `Covers the Rates page's "Hot zones" town field`.
- Change the comment `// Founder needs margin:view for the Rates button AND the Hot-zones panel to render.` to
  `// Founder needs margin:view for the Rates page AND the Hot-zones panel to render.`
- Change `// Rate card stays null → the modal shows its "Loading rate card…" placeholder` to
  `// Rate card stays null → the page shows its "Loading rate card…" placeholder`.
- Replace `openHotZones` with:

```js
async function openHotZones(page) {
  // Hot zones live on the Rates page (spec 2026-09-26 §5), not in a popup over the builder.
  await page.goto(OPS_FILE + '#rates');
  await expect(page.locator('#hz-place')).toBeVisible({ timeout: 10000 });
}
```

- [ ] **Step 4: Run the four specs and watch them fail**

Run: `cd web-tests && npx playwright test ops-rates-page ops-lookup quote-approval ops-hotzone-autocomplete --workers=2; echo "exit=$?"`

Expected: exit ≠ 0. These fail:
- every `ops-rates-page` test except the two role-bounce tests (there is no `rates-nav` yet)
- the `ops-lookup` nav-order test (4 buttons, not 5)
- the `quote-approval` founder test (`#btnRates` still exists)
- all three `ops-hotzone-autocomplete` tests (`#rates` shows no `#hz-place`)

Save the summary lines for the PR body.

- [ ] **Step 5: Shell — the Rates side-menu item**

In `api/src/routes/ops-ui.html`, replace:

```js
/* Rounded, representative marks: Bookings = event ticket (notched, perforated),
   Quotes = price tag (with the tag's eyelet), Lookup = magnifier, Analytics = trend line over an axis. */
```

with:

```js
/* Rounded, representative marks: Bookings = event ticket (notched, perforated),
   Quotes = price tag (with the tag's eyelet), Lookup = magnifier, Analytics = trend line over an axis,
   Rates = sliders (the levers the founder sets). */
```

Directly after the `  lookup:'<svg …></svg>',` entry of `NAV_ICONS`, add:

```js
  rates:'<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.75"><path d="M4 21v-7M4 10V3M12 21v-9M12 8V3M20 21v-5M20 12V3M1 14h6M9 8h6M17 16h6"/></svg>',
```

In `setNav()`, replace:

```js
  const canAnalytics=state.caps&&state.caps.includes('analytics:view');
```

with:

```js
  const canAnalytics=state.caps&&state.caps.includes('analytics:view');
  const canRates=state.caps&&state.caps.includes('margin:view');
```

and replace the last nav line:

```js
    (canAnalytics?`<button data-route="analytics" data-testid="analytics-nav" class="${state.route==='analytics'?'active':''}" title="Analytics">${NAV_ICONS.analytics}<span class="nav-txt">Analytics</span></button>`:'');
```

with:

```js
    (canAnalytics?`<button data-route="analytics" data-testid="analytics-nav" class="${state.route==='analytics'?'active':''}" title="Analytics">${NAV_ICONS.analytics}<span class="nav-txt">Analytics</span></button>`:'')+
    (canRates?`<button data-route="rates" data-testid="rates-nav" class="${state.route==='rates'?'active':''}" title="Rates">${NAV_ICONS.rates}<span class="nav-txt">Rates</span></button>`:'');
```

- [ ] **Step 6: Shell — the `rates` route**

In `routeStateFromUrl`, replace:

```js
  if(url.hash==='#analytics'&&state.caps&&state.caps.includes('analytics:view'))return { route:'analytics', routeQuoteId:null, routeBookingId:null };
```

with:

```js
  if(url.hash==='#analytics'&&state.caps&&state.caps.includes('analytics:view'))return { route:'analytics', routeQuoteId:null, routeBookingId:null };
  /* Rates (spec 2026-09-26 §5): founder-only, gated like the builder button it replaced (margin:view). */
  if(url.hash==='#rates'&&state.caps&&state.caps.includes('margin:view'))return { route:'rates', routeQuoteId:null, routeBookingId:null };
```

In `syncUrl`, replace `  else if(route==='lookup')url.hash='#lookup';` with:

```js
  else if(route==='lookup')url.hash='#lookup';
  else if(route==='rates')url.hash='#rates';
```

In `render()`, replace:

```js
  if(state.route==='lookup'&&(!state.caps||!state.caps.includes('payments:act')))state.route='tickets'; /* founder + finance; the same silent bounce */
  const entering=state.route!==_lastRenderedRoute;
```

with:

```js
  if(state.route==='lookup'&&(!state.caps||!state.caps.includes('payments:act')))state.route='tickets'; /* founder + finance; the same silent bounce */
  if(state.route==='rates'&&(!state.caps||!state.caps.includes('margin:view')))state.route='tickets'; /* founder-only; the same silent bounce */
  /* The Rates page renders in QuoteView (it shares the builder's helpers and .qv styles) but paints
     into #view — unmount it on every other route so a late rate-card/zone response can't paint
     over the page that replaced it. */
  if(state.route!=='rates')QuoteView.hideRates();
  const entering=state.route!==_lastRenderedRoute;
```

In `render()`, replace the end of the lookup branch plus the start of the default branch:

```js
      const qi=!state.routeCaseRef&&$('#lookup-q');
      if(qi)qi.focus({preventScroll:true});
    }
  }else{
    hideQuoteView();viewTickets();renderSheet();
```

with:

```js
      const qi=!state.routeCaseRef&&$('#lookup-q');
      if(qi)qi.focus({preventScroll:true});
    }
  }else if(state.route==='rates'){
    hideQuoteView();
    closeDetail('silent');
    viewRates();
    if(entering){
      playRouteIn();
      const navBtn=document.querySelector('#nav [data-route="rates"]');
      if(navBtn)navBtn.focus();
    }
  }else{
    hideQuoteView();viewTickets();renderSheet();
```

In the side-menu click handler, replace:

```js
  if(route==='lookup'&&(!state.caps||!state.caps.includes('payments:act')))route='tickets';
  setShellRoute(route,{});
```

with:

```js
  if(route==='lookup'&&(!state.caps||!state.caps.includes('payments:act')))route='tickets';
  if(route==='rates'&&(!state.caps||!state.caps.includes('margin:view')))route='tickets';
  setShellRoute(route,{});
```

In `bootApp`, replace the substring
`if(state.route==='quote'||state.route==='quotes'||state.route==='analytics'||state.route==='lookup'){render();`
with
`if(state.route==='quote'||state.route==='quotes'||state.route==='analytics'||state.route==='lookup'||state.route==='rates'){render();`.
The Rates page needs no booking data either, so it paints immediately.

Directly before the line `document.addEventListener('submit',e=>{` that is followed by
`  if(e.target.id!=='lookup-form')return;`, add:

```js
/* ── Rates (spec 2026-09-26 §5) — the founder's rate card + hot zones as a page of its own.
   The content still renders in QuoteView (same helpers, same .qv styles as the popup it
   replaced); the shell owns the header and hands QuoteView the mount. The mount is reused
   across routine shell repaints, so they neither refetch the card nor wipe a half-typed zone. */
function viewRates(){
  $('#topbar').innerHTML='';
  const view=$('#view');
  let mount=view.querySelector('#rates-mount');
  if(!mount){
    view.innerHTML=`<div class="qhead pagehead"><h1>Rates</h1></div>
    <p class="pagesub">What we charge, and the towns that carry a premium</p>
    <div id="rates-mount"></div>`;
    mount=view.querySelector('#rates-mount');
  }
  QuoteView.showRates(mount);
}
```

- [ ] **Step 7: QuoteView — the page itself**

Replace `var ratesOpen = false;    // Rate Settings modal` with:

```js
var ratesEl = null;       // the shell's #rates-mount while the Rates page is showing, else null
```

In the hot-zones block, make these changes:
- Change the header comment's first line from
  `// ── Hot zones admin (spec 2026-07-22) — founder-only pricing lever inside Rate Settings. ──`
  to `// ── Hot zones admin (spec 2026-07-22) — founder-only pricing lever on the Rates page. ──`.
- In `loadHotZones`, `hzSubmitZone`, `hzToggleZone` and `hzDeleteZone`, replace every
  `render();` with `renderRatesPage();` and every `showToast(` with `ratesToast(`. This is 1 + 3 +
  3 + 3 `render();` calls and 5 + 2 + 3 toasts. The four functions then read:

```js
async function loadHotZones() {
  try {
    var r = await api('/admin/quote/zones');
    if (!r.ok) return; // 403 handled by api(); leave list as-is
    var d = await jsonOrNull(r);
    hotZones = (d && d.zones) ? d.zones : [];
    hotZonesOff = !!(d && d.disabled);
    renderRatesPage();
  } catch (e) { window.opsReportError && window.opsReportError('hotZones list', e); /* leave prior state; a transient failure just shows the last list */ }
}

// Create or update a zone from the (uncontrolled) form inputs, read at click time. Boost > 20%
// asks for confirmation (spec D4/R3) — a high premium should feel deliberate, not routine.
async function hzSubmitZone() {
  var placeEl = document.getElementById('hz-place');
  var boostEl = document.getElementById('hz-boost');
  var activeEl = document.getElementById('hz-active');
  if (!placeEl || !boostEl) return;
  var placeName = (placeEl.value || '').trim();
  var boostPct = parseInt(boostEl.value, 10);
  var active = activeEl ? !!activeEl.checked : true;
  if (!placeName) { ratesToast('Enter a town name', 'error'); return; }
  if (isNaN(boostPct) || boostPct < 0 || boostPct > 100) { ratesToast('Boost must be 0–100%', 'error'); return; }
  if (boostPct > 20 && !window.confirm('A +' + boostPct + '% premium is unusually high. Apply it?')) return;
  hzBusy = true; renderRatesPage();
  try {
    var path = hzEditId ? '/admin/quote/zones/' + hzEditId : '/admin/quote/zones';
    var method = hzEditId ? 'PATCH' : 'POST';
    var r = await api(path, { method: method, headers: { 'content-type': 'application/json' }, body: JSON.stringify({ placeName: placeName, boostPct: boostPct, active: active }) });
    hzBusy = false;
    if (!r.ok) { var e = await errPayload(r); ratesToast(e.error === 'bad_request' ? 'Check the values' : (e.error || 'Save failed'), 'error'); renderRatesPage(); return; }
    hzEditId = null;
    ratesToast('Zone saved');
    await loadHotZones();
  } catch (e) { window.opsReportError && window.opsReportError('hotZones save', e); hzBusy = false; ratesToast('Save failed', 'error'); renderRatesPage(); }
}

async function hzToggleZone(id) {
  var z = (hotZones || []).find(function(x) { return x.id === id; });
  if (!z) return;
  hzBusy = true; renderRatesPage();
  try {
    var r = await api('/admin/quote/zones/' + id, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ active: !z.active }) });
    hzBusy = false;
    if (!r.ok) { ratesToast('Update failed', 'error'); renderRatesPage(); return; }
    await loadHotZones();
  } catch (e) { window.opsReportError && window.opsReportError('hotZones update', e); hzBusy = false; ratesToast('Update failed', 'error'); renderRatesPage(); }
}

async function hzDeleteZone(id) {
  var z = (hotZones || []).find(function(x) { return x.id === id; });
  if (z && !window.confirm('Delete the ' + z.placeName + ' hot zone?')) return;
  hzBusy = true; renderRatesPage();
  try {
    var r = await api('/admin/quote/zones/' + id, { method: 'DELETE', headers: { 'content-type': 'application/json' } });
    hzBusy = false;
    if (!r.ok) { ratesToast('Delete failed', 'error'); renderRatesPage(); return; }
    if (hzEditId === id) hzEditId = null;
    ratesToast('Zone deleted');
    await loadHotZones();
  } catch (e) { window.opsReportError && window.opsReportError('hotZones delete', e); hzBusy = false; ratesToast('Delete failed', 'error'); renderRatesPage(); }
}
```

Directly after the closing `}` of `renderHotZonesPanel()`, add:

```js
// ── Rates page (spec 2026-09-26 §5) ──────────────────────────────────────────
// Rate Settings used to be a popup over the builder; it is now a founder-only page in the ops
// side menu. The shell owns the page header and hands us #rates-mount; the card and the zones
// panel render here because they share this module's helpers (api, esc, apiPlaces) and its
// .qv-scoped CSS. `ratesEl` is non-null only while the page is showing — every async repaint
// checks it, so a response that lands after the founder has moved on paints nothing.
function ratesToast(msg, kind) {
  // The builder's own #ch-toast sits inside the hidden #quoteRoot on this route; use the shell's.
  if (window.opsToast) window.opsToast(msg, kind);
}

function renderRatesPage() {
  if (!ratesEl || !ratesEl.isConnected) return;
  var html = '<div class="qv qv-page" data-testid="rates-page">'
    + '<div class="ch-rates-card">'
    + '<div class="ch-rates-head"><span class="ch-badge tone-slate">&#x1F512; Locked</span></div>'
    + '<div class="ch-lock-note">Rates are fetched from the server and shown read-only. The engine is authoritative — changes must be deployed server-side.</div>'
    + renderRateCardBody()
    + renderHotZonesPanel()
    + '</div>'
    + '</div>';
  // Diff, not innerHTML: a zone list landing mid-typing must not wipe the Add-a-zone field.
  morphdom(ratesEl, '<div>' + html + '</div>', {
    childrenOnly: true,
    onBeforeElUpdated: function (fromEl, toEl) { return !fromEl.isEqualNode(toEl); },
  });
  attachHotZoneAutoComplete();
}

// Mount (or re-mount) into the shell's #rates-mount. A NEW mount node means the founder just
// arrived — fetch the card and the zones fresh; the same node again is a routine shell repaint.
function showRates(el) {
  var arriving = ratesEl !== el;
  ratesEl = el;
  if (arriving) {
    hzEditId = null;
    apiRateCard().then(function (rc) { if (rc) rateCard = rc; renderRatesPage(); });
    loadHotZones();
  }
  renderRatesPage();
}

function hideRates() {
  if (!ratesEl) return;
  ratesEl = null;
  hzEditId = null;
  hzacClose();
}

// The page lives outside the builder's .ch-app, so its buttons need their own delegate.
document.addEventListener('click', function (e) {
  if (!ratesEl) return;
  var el = e.target.closest('[data-action]');
  if (!el || !ratesEl.contains(el)) return;
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
  }
});
```

`hzacClose` and `attachHotZoneAutoComplete` are function declarations further down the same IIFE
(`:11453`, `:11518`), so they are hoisted and callable here.

- [ ] **Step 8: QuoteView — delete the popup and the builder button**

Replace:

```js
    renderActionBar(),
    // Rates (the rate-card settings modal) is a founder-only concern.
    (viewerCan('margin:view') ? '      <button class="ch-btn ch-btn-ghost ch-btn-sm" data-action="openRates" id="btnRates">Rates</button>' : ''),
    '    </div>',
```

with:

```js
    renderActionBar(),
    '    </div>',
```

Delete the whole `// ══ Rate Settings modal ══` block, from that comment line through
`    ].join('') : ''),` and the blank line after it (`:9744-9764`). The next line left in place is
`    // ══ "Mark booked" modal ══`.

In the builder's `app.addEventListener('click', …)` dispatcher, delete the seven branches
`openRates`, `closeRates`, `hzSubmit`, `hzEditStart`, `hzEditCancel`, `hzToggleActive` and
`hzDelete` (`:10298-10319`), so that `} else if (action === 'deleteQuote') {
runAction(action, deleteQuote);` is followed directly by `} else if (action === 'toggleOutput') {`.

At the end of the builder's `render()`, replace:

```js
  attachAutoComplete();
  attachHotZoneAutoComplete(); // same picker for the Rate-Settings zone field (#hz-place)
}
```

with:

```js
  attachAutoComplete();
}
```

In `teardown()`, replace:

```js
  acClose();
  _inited = false;
```

with:

```js
  acClose();
  hideRates();
  _inited = false;
```

Replace the module's export:

```js
return { init: init, teardown: teardown, openQuote: openQuote, startNew: startNew };
```

with:

```js
return { init: init, teardown: teardown, openQuote: openQuote, startNew: startNew, showRates: showRates, hideRates: hideRates };
```

Confirm nothing still references the popup:

Run: `grep -n "ratesOpen\|openRates\|closeRates\|btnRates" api/src/routes/ops-ui.html; echo "exit=$?"`
Expected: no lines, `exit=1`.

- [ ] **Step 9: CSS — the page wrapper**

Directly after:

```css
@media (max-width: 620px) { .qv .ch-rate-grid { grid-template-columns: 1fr; gap: 8px; }}
```

add:

```css
/* Rates page (spec 2026-09-26 §5): the rate card + hot zones as a page in the shell's #view.
   The wrapper carries .qv for the builder's tokens and components, but not its pane layout —
   the page scrolls with #view like every other shell page instead of nesting a scroll box. */
.qv.qv-page { height: auto; overflow: visible; }
.qv .ch-rates-card { max-width: 760px; background: var(--paper); border: 1px solid var(--line); border-radius: var(--r-lg); padding: 18px 20px 22px; }
.qv .ch-rates-head { display: flex; justify-content: flex-end; margin-bottom: 10px; }
```

- [ ] **Step 10: Run the four specs and watch them pass**

Run: `cd web-tests && npx playwright test ops-rates-page ops-lookup quote-approval ops-hotzone-autocomplete --workers=2; echo "exit=$?"`
Expected: every test passes, `exit=0`. Save the summary line for the PR body.

If the phone-width test fails on `overflow.view`, the likely overflow is the `.ch-hz-row` button
row. Fix it in CSS and do not loosen the test:
`.qv .ch-hz-row { flex-wrap: wrap; }`, placed next to the `.ch-hz-*` rules (`:1021-1035`). Rerun.

**As executed (2026-09-26):** the page-scroll check passed, but the phone screenshot showed the
zone row's Delete button running past the card's edge while still inside the 375px screen. The
phone test gained a "nothing pokes out of the card" assertion, which went red on `["Delete"]`.
The fix went into the row's inline style in `renderHotZonesPanel()`: `flex-wrap:wrap` on the row
and `flex:1 1 140px` on the name. The CSS rule was not enough, because the name's inline
`flex:1` would have kept winning. Green on rerun.

- [ ] **Step 11: Look at it**

Build a throwaway spec, `web-tests/e2e/zz-rates-shot.spec.js`, and never commit it. Create it
from `ops-rates-page.spec.js` up to and including its `const ratesPage` line, which covers the
imports, constants, `boot`, `ready` and `ratesPage`:
`sed -n '1,/^const ratesPage/p' web-tests/e2e/ops-rates-page.spec.js > web-tests/e2e/zz-rates-shot.spec.js`.
Then append:

```js
test('screenshots', async ({ page }) => {
  await boot(page, FOUNDER);
  await page.goto(OPS_FILE + '#rates');
  await page.waitForSelector('[data-testid="rates-page"] .ch-hz-row');
  await page.screenshot({ path: process.env.SHOT_DIR + '/rates-desktop.png', fullPage: true });
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({ path: process.env.SHOT_DIR + '/rates-phone.png', fullPage: true });
});
```

Run:
`cd web-tests && SHOT_DIR=/private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad npx playwright test zz-rates-shot; rm e2e/zz-rates-shot.spec.js`.
Then open both PNGs with the Read tool. Check three things:
- the header reads "Rates"
- the card matches the old popup's content: two columns on desktop, one on phone
- the hot-zones panel and form render with bordered fields

- [ ] **Step 12: Full gates**

Run: `cd api && npm run check; echo "exit=$?"` (timeout 600000). Set
`DATABASE_URL_TEST` to the local `ceylonhop_test` database so the Postgres suites run instead of
silently skipping (memory: *Local api gate needs DATABASE_URL_TEST*). Never point it at
`api/.env`'s `DATABASE_URL`, which is prod.
Expected: typecheck, lint and Vitest all pass, `exit=0`.

Run: `cd web-tests && npm run test:all; echo "exit=$?"` (timeout 600000)
Expected: Vitest and Playwright summaries both pass, `exit=0`.

- [ ] **Step 13: Commit**

```bash
git add web-tests/e2e/ops-rates-page.spec.js web-tests/e2e/ops-lookup.spec.js \
  web-tests/e2e/quote-approval.spec.js web-tests/e2e/ops-hotzone-autocomplete.spec.js \
  api/src/routes/ops-ui.html
git commit -m "feat(ops): Rates gets its own page in the side menu

Rate Settings leaves the quote builder: a founder-only Rates item (margin:view,
after Analytics) opens the same read-only rate card and hot-zones panel as a
page. The content still renders in QuoteView (shared helpers + .qv styles)
into the shell's #rates-mount; hideRates() on every other route keeps a late
card/zone response from painting over the next page. No price changes.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ship PR 1

- [ ] **Step 1: Re-check main before pushing.** Other sessions share `ops-ui.html`, the hot file.

Run: `git fetch origin && git log --oneline HEAD..origin/main`
If main moved and touched `api/src/routes/ops-ui.html`, merge `origin/main` into the branch.
Re-run Task 1 Steps 10 and 12, and resolve any `?v=` stamp conflict by regenerating (memory:
*Stamp conflicts: regenerate, never --theirs*).

- [ ] **Step 2: Push and open the PR**

```bash
git push -u origin feat/ops-rates-page
gh pr create --base main --title "feat(ops): Rates gets its own page in the side menu" --body-file /private/tmp/claude-501/-Users-roshenw-claude-code-ceylon-hop/6f800f3b-5474-4fa1-b29e-e12f376cd3e6/scratchpad/pr1-body.md
```

The PR body covers:
- **Summary:** move only, no price changes.
- **Links:** the spec and this plan.
- **Evidence:** the red run (Step 4) and green run (Step 10) summary lines, and the `npm run check`
  and `test:all` exit lines.
- **Screenshots:** desktop and phone.
- **Release:** this reaches staging on merge and prod on the next promote. There is no migration.

It ends with the PR attribution line.

- [ ] **Step 3: CI.** Bind the PR with the ccd_pr tools, read its checks, and fix any red check
  before asking the owner to merge.
