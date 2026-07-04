# Ops ⇄ Quote Tool Merge — Implementation Plan (v2, post-critique)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development to implement this plan task-by-task with Fable 5 implementers + independent review gates. Steps use checkbox (`- [ ]`) tracking.

**Goal:** Fold the internal quote tool into the ops dashboard as a second **founder-only view** in one unified console served at `/ops`, sharing a single ops login — with the quote tool's pricing logic, save/recent lifecycle, and design preserved intact.

**Architecture:** Do **not** concatenate the two apps at global scope (they collide on `state`, `api`, `render`, `esc`, `fmtDate`, and on `:root` CSS tokens with *different* values). Instead: (1) keep `ops-ui.html` as the shell, (2) inject the quote app's `<script>` wrapped in a single **IIFE module** that encapsulates all its globals and exposes one `QuoteView = { init, teardown }`, (3) inject the quote app's `<style>` **scoped under a `.qv` wrapper** (its `:root` tokens rehomed to `.qv`), (4) swap the quote module's `api()` from `localStorage` admin-key to the **ops session cookie**, and (5) add a founder-only "Quote" rail nav that lazy-mounts the quote view. Backend: unify auth so `/admin/quote/*` accepts a **founder `ch_ops` session cookie** OR the legacy `x-admin-key`.

**Tech Stack:** Node 20 · TypeScript strict · Hono · Zod · Vitest · Drizzle+Postgres · vanilla JS (no framework/bundler) · Playwright (web-tests).

## Global Constraints

- Backend lives in `api/` only; never touch root frozen front-end files. **`_ops-preview.html` (repo root) is frozen and OUT OF SCOPE** — it will drift further from `ops-ui.html` after this merge; that's a known, already-tracked follow-up (`docs/ops-dashboard-status.md` "Retire the root `_ops-preview.html` mock"), not this PR's concern. The merged UI file is `api/src/routes/ops-ui.html` (inside `api/`, allowed).
- Tests-first for backend (red→green evidence in each PR). `cd api && npm run check` must be green before any PR.
- Money is integer minor units; **all pricing stays 100% server-authoritative** — the quote module must not gain any client-side price math. Preserve the `_estimateSeq` stale-guard and all debounces (350ms estimate/distance, 220ms places) exactly.
- Quote access is **founder-only**, enforced on the **backend** (`/admin/quote/*`), not merely hidden in the UI. Support role must get 403 on quote data routes and must not see the Quote nav.
- Do not change the `/admin/quote/*` request/response contracts or the pricing engine. The only backend change is the auth guard + CSRF check + the `GET /` redirect.
- Preserve the quote tool's focus/autocomplete-menu preservation dance across re-render (`captureEditorFocus`/`restoreEditorFocus`/`reopenAutoCompleteMenu`) — it fixed real flicker bugs and is Global-Constraint-critical.
- No secret in client JS. Remove all `localStorage['chAdminKey']` / `x-admin-key` / `prompt()` usage from the merged UI, and proactively clear any stale `chAdminKey`.
- **The UI tasks T3→T4→T5→T6 all edit the same file (`ops-ui.html`) with cascading dependencies and MUST run strictly serially — never dispatch them to parallel subagents.** T1→T2 (backend) are serial with each other. Backend T1 must land before T5's verification (T5 checks cookie-auth works with no admin-key prompt). Order: T1, T2, T3, T4, T5, T6, T7, T8.
- Single branch `ops-quote-merge`, per-task commits, one PR at end. **Rollback = `git revert` the squash-merge commit**, which atomically restores `quote-tool.html`, the old `GET /admin/quote` handler, and the old auth guard together. Note: until reverted, a broken `/ops` leaves founders with no quote access (the standalone tool is gone) — prefer Render's one-click "rollback to previous deploy" for the fast path.

## Design decisions (recorded — do not re-litigate)

- **D1 — Isolation over fusion.** Quote app keeps its own `state`/`render`/DOM inside a private IIFE and scoped container; the ops app is untouched structurally. Preserves pricing fidelity, slashes regression risk.
- **D2 — Scope, don't restyle (v1).** Quote view keeps its Bodoni/Poppins cockpit look, scoped under `.qv` so it can't reskin the ops espresso/Newsreader shell. Full visual unification is an explicit **follow-up**. Minimal de-jank is in-scope (opaque `.qv` background, a rail divider, correct scroll/overlay containment) — see T4.
- **D3 — Founder-only.** The quote surface (UI nav + `/admin/quote/*` data routes) is founder-gated. Support sees only Bookings and is 403'd on quote data.
- **D4 — Keep `x-admin-key` working.** Legacy admin-key path stays valid on `/admin/quote/*` (CLI/scripts). New path: founder `ch_ops` cookie also authorizes; support cookie does not. **Blast-radius note:** `ADMIN_API_KEY` already unlocks `/admin/ops` + `/admin` and now more actively-browsed `/admin/quote` margin/PII — recorded in T8 security pass; rotation posture per go-live checklist.
- **D5 — Retire the standalone quote shell.** `GET /admin/quote` (HTML) redirects to `/ops`; the `/admin/quote/*` JSON API stays. `quote-tool.html` deleted after absorption.
- **D6 — Lazy mount.** The quote view's `boot()` runs only on first navigation to the Quote tab, not on page load.
- **D7 — CSRF: Sec-Fetch-Site then Origin.** State-changing `/admin/quote/*` routes reject cross-site requests using `Sec-Fetch-Site` (browser-set, unspoofable) first, falling back to an `Origin` allow-list, only passing when both are absent (true non-browser callers keep working). SameSite=Lax `ch_ops` is the base layer.

---

## Task 1: Backend — prod session-secret guard + unify `/admin/quote/*` auth (founder cookie OR admin key)

**Files:**
- Modify: `api/src/config.ts` (fail-closed guard on `OPS_SESSION_SECRET` in production)
- Modify: `api/src/routes/internalQuote.ts` (guard + `sessionSecret` dep)
- Modify: `api/src/app.ts` (pass `sessionSecret` into `internalQuoteRoutes`)
- Test: `api/src/config.test.ts` (new or existing), `api/src/routes/internalQuote.test.ts`

**Interfaces:**
- Consumes: `verifySession(token, secret)` and `signSession(role, secret)` from `api/src/lib/opsAuth.ts`; `getCookie` from `hono/cookie`; cookie name `ch_ops` (mirror the `COOKIE` constant from `ops.ts`).
- Produces:
  - A production fail-closed check (rationale: the founder cookie now unlocks quote margin/PII, so a defaulted secret is a founder-forgery hole): when `NODE_ENV==='production'`, if `OPS_SESSION_SECRET` is empty or equals the dev default `'dev-ops-secret-change-me'`, **throw at config load / app boot** (do not fail open). In dev/test the default is allowed.
  - `internalQuoteRoutes(deps: { maps, quotes, adminKey?, allowNoKey?, sessionSecret?: string, allowedOrigins?: string[] })`. New guard (replaces the current one; the open `GET /` stays above it, but see T2 where `GET /` becomes a redirect):

```ts
r.use('*', async (c, next) => {
  const key = c.req.header('x-admin-key');
  if (deps.adminKey && key && key === deps.adminKey) return next();      // legacy admin key → founder
  const role = verifySession(getCookie(c, COOKIE), deps.sessionSecret ?? '');
  if (role === 'founder') return next();                                  // founder ops session
  if (role === 'support') return c.json({ error: 'forbidden' }, 403);     // support: never quote data
  if (!deps.adminKey && deps.allowNoKey) return next();                   // dev-only keyless bypass
  return c.json({ error: 'unauthorized' }, 401);
});
```

- [ ] **Step 1 — failing tests.** (a) `config.test.ts`: with `NODE_ENV=production` + `OPS_SESSION_SECRET` unset/`'dev-ops-secret-change-me'`, loading config/creating the app throws; with a real secret it doesn't; in test env the default is tolerated. (b) `internalQuote.test.ts` (build cookies with `signSession('founder'|'support', SECRET)`, pass `sessionSecret: SECRET, adminKey: 'K'`). Enumerate **every data route**, not just `/rate-card`:

```ts
const founder = `ch_ops=${signSession('founder', SECRET)}`;
const support = `ch_ops=${signSession('support', SECRET)}`;
// founder cookie authorizes reads AND the PII/margin routes:
for (const p of ['/admin/quote/rate-card', '/admin/quote/list']) {
  expect((await app.request(p, { headers: { cookie: founder } })).status).toBe(200);
}
// support cookie is forbidden on every data route (margin/PII):
for (const p of ['/admin/quote/rate-card', '/admin/quote/list', '/admin/quote/x']) {
  expect((await app.request(p, { headers: { cookie: support } })).status).toBe(403);
}
expect((await app.request('/admin/quote/estimate', { method:'POST', headers:{cookie:support,'content-type':'application/json'}, body:'{}' })).status).toBe(403);
// legacy key still works; no auth 401s; forged cookie 401s:
expect((await app.request('/admin/quote/rate-card', { headers:{'x-admin-key':'K'} })).status).toBe(200);
expect((await app.request('/admin/quote/rate-card')).status).toBe(401);
expect((await app.request('/admin/quote/rate-card', { headers:{cookie:`ch_ops=${signSession('founder','WRONG')}`} })).status).toBe(401);
```
Also add: support cookie + `adminKey` unset + `allowNoKey:true` → still **403** (support never falls through the dev bypass). Keep the existing `allowNoKey` dev-bypass-with-no-cookie test (200).

- [ ] **Step 2 — RED:** `cd api && npx vitest run src/config.test.ts src/routes/internalQuote.test.ts`.
- [ ] **Step 3 — implement** the config guard + the guard middleware + add `sessionSecret` to the factory deps. In `app.ts`, update the mount **exactly** (this is the same line T2 also edits — see T2 for the final merged form): add `sessionSecret: opsAuthCfg.sessionSecret`.
- [ ] **Step 4 — GREEN:** `cd api && npm run check`.
- [ ] **Step 5 — commit:** `feat(quote): founder ops-session auth for /admin/quote + prod session-secret guard`

---

## Task 2: Backend — CSRF (Sec-Fetch-Site/Origin) on mutations; retire standalone quote shell; fix rate-limit drift

**Files:**
- Modify: `api/src/routes/internalQuote.ts` (CSRF check on POST/PATCH; `GET /` → redirect; drop `toolHtml`/`readFileSync`)
- Modify: `api/src/app.ts` (pass `allowedOrigins`; update the `adminQuoteLimiter` carve-out comment)
- Test: `api/src/routes/internalQuote.test.ts`, `api/src/routes/security.test.ts`

**Interfaces:**
- Consumes: the app's allowed-origins list (already built for CORS in `app.ts`) → pass `allowedOrigins: string[]`.
- Produces:
  - A CSRF helper applied to `POST /distance|/estimate|/save` and `PATCH /:id`:
    - If `Sec-Fetch-Site` present and ∉ `{'same-origin','none'}` → `403 { error:'bad_origin' }`.
    - Else if `Origin` present and ∉ `allowedOrigins` → `403 { error:'bad_origin' }`.
    - Else pass (both absent = non-browser caller; still protected by the T1 auth guard).
    - GET reads (`/places /rate-card /list /:id`) are exempt (not CSRF-sensitive; autocomplete must stay fast).
  - `GET /` → `c.redirect('/ops', 302)`. Remove `toolHtml()`/`cachedHtml`/`readFileSync` of `quote-tool.html`.
  - **`app.ts` final mount (merged with T1's `sessionSecret`) — write it exactly, to avoid the two edits clobbering the same line:**
```ts
app.route('/admin/quote', internalQuoteRoutes({
  maps, quotes,
  adminKey: adminApiKey,
  allowNoKey: config.NODE_ENV !== 'production',
  sessionSecret: opsAuthCfg.sessionSecret,
  allowedOrigins,
}));
```
  - **`app.ts` rate-limit carve-out:** the `adminQuoteLimiter` skip for exact path `/admin/quote` needs **no logic change** (a 302 is still fine to leave unthrottled), but update its comment (no longer "the HTML shell" — it's now a redirect to `/ops`).

- [ ] **Step 1 — failing tests.** (a) founder-cookie `POST /admin/quote/estimate` with `Sec-Fetch-Site: cross-site` → 403; with `Origin: https://evil.example` (no Sec-Fetch-Site) → 403; with `Origin` == the **app's own serving origin** (the one that serves `/ops`, e.g. `http://localhost:8787` in tests — **verify it is in `allowedOrigins`**, add it if missing) → **not** 403; with neither header → not 403. (b) `GET /admin/quote` → 302, `location: /ops`. (c) update `security.test.ts`'s "GET /admin/quote is NOT throttled" test to assert the **302** (not 200 HTML).
- [ ] **Step 2 — RED:** `npx vitest run src/routes/internalQuote.test.ts src/routes/security.test.ts`.
- [ ] **Step 3 — implement.** Confirm the `/ops`-serving origin is present in `ALLOWED_ORIGINS` for dev/staging/prod (add if missing — otherwise legitimate founder Save/Estimate calls 403).
- [ ] **Step 4 — GREEN:** `npm run check`.
- [ ] **Step 5 — commit:** `feat(quote): CSRF (Sec-Fetch-Site/Origin) on mutations; redirect /admin/quote → /ops`

---

## Task 3: UI — merged-shell scaffold (founder-only Quote nav + route switching + scroll container)

**Files:**
- Modify: `api/src/routes/ops-ui.html`
- Test: `api/src/routes/opsUi.test.ts`

**Interfaces:**
- Consumes: ops `state` (has an unused `state.route` seam), `bootApp(role)`, `render()`, `setNav()`, `#nav`, `#view` (which IS `.scroll`, `overflow-y:auto`), `#topbar`.
- Produces:
  - `bootApp(role)` stores `state.role = role` and exposes `window.opsShowLogin = showLogin` (so the quote module can reach it without importing ops internals).
  - Nav is rendered in `setNav()`/`renderNav()` (not static): always a Bookings `<button data-route="tickets">`; a `<button data-route="quote">Quote</button>` **only when `state.role==='founder'`**.
  - **NEW** delegated click listener (the file has **no** existing `[data-route]` handler — only a `[data-act]` switch): on `#nav [data-route]` click → set `state.route`, update `location.hash`, `render()`. If a non-founder's `state.route` is ever `'quote'`, force it back to `'tickets'`.
  - `render()` branches: `if(state.route==='quote'){ showQuoteView(); } else { hideQuoteView(); viewTickets(); renderSheet(); }`.
  - A scoped, self-scrolling container in `.main`, sibling to `#view`: `<div class="qv" id="quoteRoot" hidden></div>` with CSS `#quoteRoot{height:100%;overflow-y:auto}` (it must scroll like `.scroll` does, since `.app` is `height:100vh;overflow:hidden`). `showQuoteView()` unhides `#quoteRoot`, hides `#view`+`#topbar`; `hideQuoteView()` reverses it.
  - Empty container only in this task (no quote code yet).

- [ ] **Step 1 — test (`opsUi.test.ts`):** the served shell contains `data-route="quote"` gated behind a `role==='founder'` check in the script text, contains `id="quoteRoot"`, and the **existing** assertions still hold: contains `Ceylon Hop`, contains `/admin/ops`, does **not** contain `CH-TMRJR`.
- [ ] **Step 2 — RED:** `npx vitest run src/routes/opsUi.test.ts`.
- [ ] **Step 3 — implement.** **Preview-verify:** login founder → Quote nav appears; click → empty `.qv` panel scrolls independently, `#view`/`#topbar` hidden; back → Bookings restored with its scroll position; login support → no Quote nav; forcing `state.route='quote'` as support snaps back to Bookings. Confirm the Bookings search input has no residual focus/value when hidden then re-shown.
- [ ] **Step 4 — GREEN:** `npm run check` + screenshots (founder sees tab, support doesn't).
- [ ] **Step 5 — commit:** `feat(ops): founder-only Quote nav, route switching, scoped scroll container`

---

## Task 4: UI — port the quote CSS scoped under `.qv` (containment + de-jank)

**Files:** Modify `api/src/routes/ops-ui.html` (`<head>` fonts + a scoped `<style>` block).

**Interfaces / transformation rules (exact):**
- **Fonts:** merge into the **single existing** ops `<link>` — one `css2?family=Newsreader:…&family=Hanken+Grotesk:…&family=JetBrains+Mono:…&family=Bodoni+Moda:wght@500;600;700;800&family=Poppins:wght@400;500;600;700&display=swap`. **Drop** quote-tool.html's duplicate `preconnect` pair (reuse the ops one).
- **Scope every quote rule under `.qv`:** transform `.ch-*{…}` → `.qv .ch-*{…}`, **including selectors nested inside the 8 `@media` blocks and the 1 `@container` block** (the transform must walk into at-rule bodies, not just top-level lines). (No `@keyframes`/`@font-face`/`::selection` exist in the quote CSS — verified — so those need no special handling.)
- **Rehome the quote `:root`** tokens to **`.qv { …--blue/--cream:#F0EEE5/--ink:#3A3739/--line/--paper/--serif/--sans/--r-lg… }`** so they scope to the quote subtree and don't override ops' `:root`.
- **Rehome body-level rules** (the quote radial-gradient background, base `font-size:14px`) to `.qv`. Give `.qv` an **opaque** `background: var(--cream)` (quote's cream) so it fully occludes the ops `.main` gradient/noise rather than layering.
- **Containment fixes (critical — the cockpit was authored for full viewport):**
  - `.qv .ch-app{ min-height:0; height:100% }` (kill the `min-height:100vh` that would overflow `.main`).
  - `.qv{ position:relative; height:100%; overflow-y:auto }` (own scroll box; also the positioning context for the toast fix in T5).
  - **Breakpoint math:** the governing `.ch-cockpit`(`960px`) and `.ch-main`(`1080px`) `@media` fire on the *viewport*, but `.main` is `viewport − 254px`. Convert these two to **container queries** scoped to `.qv` (`.qv{container-type:inline-size}` + `@container (max-width:960px)/(max-width:1080px)`), OR (cheaper v1) offset the two `@media` thresholds by +254px (→1214px/1334px) **only within `.qv`**. Container queries preferred.
  - **Rail divider:** `.qv{ border-left:1px solid var(--line) }` (ops line color) so the dark-rail↔cream-quote seam reads as an intentional pane divider.
- **Overlays:** `.ch-modal`/`.ch-drawer`/`.ch-scrim` staying `position:fixed` (covering the rail) is **acceptable** (modal focus-lock UX). The **toast** is fixed at `left:50%` → visually off-center vs `.main`; T5 changes `.qv .ch-toast` to `position:absolute` inside `.qv{position:relative}` so it centers within the content area (documented here, applied with the toast move in T5).
- No JS yet; the `.qv` panel is empty. The ops Bookings view must be **pixel-identical** to before.

- [ ] **Step 1 — implement** the scoped CSS + merged fonts + containment.
- [ ] **Step 2 — verify:** (a) Bookings view visually unchanged; `preview_inspect` a `.card` and confirm it still resolves ops `--ink:#241f1d`/`--cream:#F1EEE4` (proving the quote `:root` no longer leaks). (b) **Automated leak check:** grep the merged CSS for any `.ch-` selector occurrence not preceded by `.qv ` (including inside `@media`/`@container`) → must be zero.
- [ ] **Step 3 — GREEN:** `npm run check` + a screenshot of the unchanged Bookings view + the grep result.
- [ ] **Step 4 — commit:** `feat(ops): inject quote CSS scoped under .qv with containment + de-jank`

---

## Task 5: UI — port the quote JS as an encapsulated module on the ops session

**Files:** Modify `api/src/routes/ops-ui.html` (append quote `<script>` as a module; wire `showQuoteView`).

**Interfaces / transformation rules (exact):**
- Wrap the **entire** quote `<script>` body in `const QuoteView = (function(){ … return { init, teardown }; })();`. Closure-scoping resolves **all** name collisions (`state`, `render`, `esc`, `api`, `fmtDate`, `showToast`, ~120 others). **Note (self-review):** encapsulation resolves *name* collisions only; the `window.addEventListener('beforeunload', …)` at the quote's top level registers on the shared `window` regardless of closure — it is NOT resolved by the IIFE and must be handled by the `_dirty` gating + teardown in T6 (with its own test).
- **Mount node — replace ALL SIX `#app` references** (grep-verify zero remaining literal `#app`): (1) `document.getElementById('app').innerHTML=html` (render), (2) the `'#app [data-leg="…"] …'` selector in `reopenAutoCompleteMenu`, (3) `el.matches('#app input, #app textarea')` in `captureEditorFocus`, (4) the `'#app [data-leg=…]'` selector in `restoreEditorFocus`, (5) `'#app #'+snap.id` in `restoreEditorFocus`, (6) `document.getElementById('app')` in `attachEventListeners` (the `_delegatesWired` root). All become the module's inner render target.
- **Toast placement (mirror the original "toast outside #app" architecture):** the quote render does `innerTarget.innerHTML = html`. Structure the container as `#quoteRoot > .ch-app-inner` (render target) **and** `#quoteRoot > #ch-toast` (sibling, NOT a child of the render target) so render() never destroys the toast. Change `.qv .ch-toast` to `position:absolute` (T4 made `.qv` `position:relative`) so it centers within `.main`.
- **Auth swap — session cookie, handle 401 AND 403:**
```js
async function api(path, opts){
  opts = opts || {};
  const res = await fetch(path, Object.assign({}, opts, { credentials:'same-origin' }));
  if (res.status === 401){ window.opsShowLogin && window.opsShowLogin(); }
  if (res.status === 403){ showToast('Founder access required'); window.opsGoBookings && window.opsGoBookings(); }
  return res;
}
```
  Preserve callers' `content-type: application/json` (the `Object.assign` passes `opts.headers` through untouched — do **not** add a headers-merge step). Remove `localStorage['chAdminKey']`, the `x-admin-key` header, the `prompt()` retry. **Also rewrite the second 401 branch in `apiPlaces`** (delete the `_authToastShown` / "Not authenticated — check the admin key" toast — that copy is from the admin-key world; a 401 now just surfaces the ops login via `api()`).
- **Lazy boot:** rename the self-invoking `(async function boot(){…})()` to `async function init()` (part of the returned object) and do **not** self-invoke. `showQuoteView()` (ops side) unhides `#quoteRoot`, hides `#view`/`#topbar`, and calls `QuoteView.init()` once (guard `_inited`). Expose `window.opsGoBookings = ()=>{ state.route='tickets'; render(); }`.
- **Stale-key cleanup:** on ops boot, `localStorage.removeItem('chAdminKey')` (old secrets shouldn't linger).
- Pricing/estimate/save/recent/templates/autocomplete/distance otherwise **unchanged** — same debounces, `_estimateSeq` guard, server-authoritative flow, focus-preservation dance (now rooted at the inner render target).

- [ ] **Step 1 — implement** the module wrap + all transformations.
- [ ] **Step 2 — verify (preview, founder):** Quote tab → cockpit renders inside the ops shell; add a leg (Kandy→Ella), autocomplete picks (server `/places`, **no admin-key prompt**), van vehicle → priced total appears (`/estimate`), WhatsApp template renders, Save persists (`/save`) → Recent. Type into a place field and trigger a re-render (add leg) → **cursor/typing preserved** (focus dance intact). Switch Bookings↔Quote → quote state intact, ops DOM not stomped. **Network tab:** quote calls carry the cookie and `content-type: application/json`, **no `x-admin-key`**; `localStorage.chAdminKey` is gone. Console: zero errors.
- [ ] **Step 3 — GREEN:** `npm run check` + screenshots + network evidence.
- [ ] **Step 4 — commit:** `feat(ops): mount quote tool as an encapsulated founder view on the ops session`

---

## Task 6: UI — cross-view polish (logout teardown, deep-link, focus/scroll, event isolation)

**Files:** Modify `api/src/routes/ops-ui.html`.

**Interfaces:**
- **Logout** extends the `#logoutbtn` handler to `QuoteView.teardown()` — reset `_inited`, clear `_dirty` + all timers (`_estimateTimer`, `_distTimers`, `_ac.timer`), empty the render target — so re-login is clean and no stale `beforeunload` fires.
- **Deep-link:** on boot read `location.hash` — `#quote` → quote view (founder only; support → Bookings); update the hash on nav so a founder can refresh/bookmark into the quote view.
- **Focus/scroll on switch:** preserve `#view.scrollTop` across hide/show (store in `state` or verify `hidden`-toggle preserves it); on route entry move focus to a sensible element (Bookings → topbar search; Quote → first cockpit field or the nav button) so keystrokes never land on a hidden element.
- **Event isolation checks:** ops `document` keydown (`Escape` → sheet) no-ops on the quote route because `state.detail` stays null — verify. Quote autocomplete `Escape` is a per-input handler; pressing Escape with a dropdown open closes it (acClose) and the ops keydown no-ops (state.detail null) — verify explicitly. No double-toast (ops `#toast` vs quote `.qv .ch-toast` belong to different views).

- [ ] **Step 1 — implement.**
- [ ] **Step 2 — verify (preview):** logout from quote view → login overlay, render target cleared, **no "leave site?" prompt**; a pure Bookings-only session then navigating away → **no** beforeunload prompt; `/ops#quote` refresh as founder → quote view, as support → Bookings; rapidly toggle Bookings↔Quote 10× → no leaked listeners/timers (check console/`getEventListeners`); open quote autocomplete, press Escape → only the dropdown closes.
- [ ] **Step 3 — GREEN:** `npm run check` + evidence.
- [ ] **Step 4 — commit:** `feat(ops): quote view teardown, deep-link, focus/scroll, event isolation`

---

## Task 7: Tests — e2e via `/ops` founder login; update/retire backend tests; delete standalone file

**Files:**
- Modify: `web-tests/e2e/quote-tool.spec.js`, `web-tests/playwright.config.js`
- Create: `web-tests/e2e/ops-ui.spec.js`
- Delete: `api/src/routes/quote-tool.html`
- Modify: `api/src/routes/internalQuote.test.ts` (enumerated below), `api/src/routes/opsUi.test.ts` (finalize)

**Interfaces:**
- **Playwright login = POST the login form (single documented approach; drop `addCookies`).** In `beforeEach`: `POST http://localhost:8787/admin/ops/login {key: OPS_FOUNDER_KEY}`, capture `Set-Cookie`, inject via `context.addCookies` — OR drive the login form UI. This needs only `OPS_FOUNDER_KEY` (no cross-package `signSession` import / secret-sharing). **Set `OPS_FOUNDER_KEY` (and `OPS_SUPPORT_KEY`, `OPS_SESSION_SECRET`) in `playwright.config.js`'s `CH_E2E_API` `webServer.env` block**, and skip the spec (like the `CH_E2E_API` skip) if `OPS_FOUNDER_KEY` is empty.
- `quote-tool.spec.js`: change `TOOL` to `http://localhost:8787/ops`; after founder login, click the **Quote** nav, then run the existing selectors scoped under `#quoteRoot`/`.qv` (`#f-vehicleType`, `#btnSave`, `#statusSelect`, `#btnRecent`, `.ch-tl-title[data-field=…]`, `.ch-line.strong .ch-line-val`). Keep the `CH_E2E_API` gate + the `chooseVehicle` 350ms-rerender helper.
- `ops-ui.spec.js` (new, `CH_E2E_API`-gated) — convert the manual preview bullets into **permanent assertions**: (a) founder login → Bookings queue renders; (b) founder sees Quote nav, support does not; (c) **lazy-mount**: `/admin/quote/rate-card` is NOT requested until the Quote nav is clicked; (d) support-cookie API call → `/admin/quote/rate-card` returns **403** (end-to-end, not just unit); (e) CSS non-leak: computed style of a `.card` shows ops `--ink`/`--cream` values; (f) deep-link `/ops#quote` founder vs support; (g) logout → `#quoteRoot` empty/hidden, no beforeunload dialog; (h) Bookings→Quote→Bookings round-trip with a single-toast assertion.
- `internalQuote.test.ts` — **explicit edits**: DELETE the entire `GET / (toolHtml) resilience to a failing read` describe block (3 tests, the `readFileSync` mock); change/delete the two "serves the HTML shell" tests (`without a key`, `still serves when locked`) to assert the **302 → /ops** (or remove as redundant with T2's redirect test). **Before injecting**, grep the ported quote content for `CH-TMRJR`/mock booking ids (must be none) so `opsUi.test.ts`'s `not.toContain('CH-TMRJR')` keeps passing.

- [ ] **Step 1 — implement** spec updates + new spec + file deletion + `internalQuote.test.ts` edits + `internalQuote.ts` `toolHtml` removal (also part of T2).
- [ ] **Step 2 — run:** `cd api && npm run check` (green); `cd web-tests && CH_E2E_API=1 npm run test:e2e:tool` and `CH_E2E_API=1 npx playwright test ops-ui` against a locally-booted API + `OPS_FOUNDER_KEY`/`OPS_SUPPORT_KEY` set. Document anything needing the live DB.
- [ ] **Step 3 — GREEN:** paste passing output.
- [ ] **Step 4 — commit:** `test(ops): e2e via /ops founder login; retire standalone quote shell + tests`

---

## Task 8: Full verification + deploy (no PR — evidence)

- [ ] `cd api && npm run check` fully green; record counts. Measure the merged `ops-ui.html` size (~180KB expected, up from 45KB); if the host/CDN doesn't already gzip, add Hono `compress()` (or a `Cache-Control` on the static shell). Note the **hot-reload caveat**: `opsUi.ts` caches forever after first read, so iterative edits need a dev-server restart.
- [ ] Preview E2E vs dev Supabase as **founder**: login → Bookings → Quote tab → build/price/save a quote (server total matches, WhatsApp/Email/Internal templates render, Recent updates, status PATCH) → back to Bookings (state intact) → logout. As **support**: no Quote nav; `curl` `/admin/quote/rate-card` with a support cookie → 403.
- [ ] **Security pass:** `/admin/quote/*` → 401 no-auth, 403 support, 200 founder-cookie AND `x-admin-key`; `Sec-Fetch-Site: cross-site` / foreign `Origin` on a quote POST → 403; same-origin POST → not 403; `GET /admin/quote` → 302 `/ops`; config boots only with a real `OPS_SESSION_SECRET` in prod. **Record the widened blast radius:** `ADMIN_API_KEY` now also gates margin/PII quote data — reconfirm rotation posture in the go-live checklist.
- [ ] **Deploy:** UI + auth only — **no DB migration** (quote table/repo already exist; contracts frozen). Confirm the `/ops`-serving origin is in prod `ALLOWED_ORIGINS`. Confirm prod `OPS_SESSION_SECRET` is a real secret (else boot fails, by design). Merge PR → Render auto-deploys. **Rollback:** Render one-click previous-deploy, or `git revert` the squash commit (restores `quote-tool.html` + old handler + old guard atomically). Update `docs/ops-dashboard-status.md` + memory (quote tool now lives in `/ops`, founder-only). Follow-ups: full visual unification (D2); optional support read-only quote view; session-expiry claim in the HMAC (go-live).

---

## Self-review checklist
- **Dimension coverage:** UI (T3–T6), UX/responsive+containment (T3,T4,T6), Backend (T1–T2), Auth (T1, T5 swap), Security/CSRF + prod secret guard (T1,T2,T8), API calls (T5 contracts frozen, cookie swap), quote-calc logic (preserved verbatim — D1,T5; `content-type` kept; `_estimateSeq`/debounces closure-scoped intact), consistency/design (T4 scoping + de-jank, D2), testing (T1,T2,T3,T7,T8 with manual bullets promoted to automated e2e).
- **Collision completeness:** name collisions (`state`/`api`/`render`/`esc`/`fmtDate`) → IIFE (T5); **`window` beforeunload is NOT covered by the IIFE** → `_dirty` gating + teardown + dedicated test (T6); CSS tokens/`.ch-*` (incl. inside `@media`/`@container`) → `.qv` scoping + grep check (T4); all **6** `#app` references → `#quoteRoot`/inner-target + grep check (T5).
- **No client secret** remains; stale `chAdminKey` cleared (T5). Founder-only enforced backend + UI + e2e (T1,T3,T7).
- **Type/interface consistency:** `sessionSecret` + `allowedOrigins` added to `internalQuoteRoutes` deps (T1/T2) and consumed in the single merged `app.ts` mount call (T2 shows the exact form to avoid clobber); `window.opsShowLogin`/`window.opsGoBookings` exposed in T3/T5 and referenced by the module.
- **Non-issues confirmed:** M17 client-error beacon has no footprint in either HTML file (no merge handling needed); `_ops-preview.html` is frozen/out-of-scope (known drift follow-up); no DB migration needed.
