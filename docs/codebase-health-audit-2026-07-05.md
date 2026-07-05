# Ceylon Hop — Codebase Health Audit (2026-07-05)

Full-repo hygiene pass (front-end JS, HTML/CSS, backend, tooling/tests/docs). Overall the
codebase is **healthy**: backend `tsc --noEmit` is clean with **zero** TODO/FIXME/HACK
markers and no stray debug logging; the test suite is green (167 unit + 39 e2e). Findings
below are mostly polish. Fixes marked ✅ were applied on branch `codebase-hygiene`; the rest
are deferred with rationale.

## Applied on this branch ✅

| # | File | Change | Why |
|---|------|--------|-----|
| 1 | `manage.html` | Added `robots: noindex,nofollow` + `theme-color` + favicon | **Privacy**: the page renders a customer's booking (name/route/price) by token and was fully indexable. Was also the only page missing theme-color/favicon. |
| 2 | `booking.js:4` | Removed dead `initChrome ? null : null;` | No-op stub (references but never calls `initChrome`; booking uses its own `bk-brand` header, not the shared nav). |
| 3 | `booking.js:636` | Removed dead `window.pickDep` | Zero callers — superseded by `pickDepSel` (wired to the `#dep-select` `onchange`). |
| 4 | `booking.html:546` | Removed hidden `s3-title`/`s3-sub` | Leftover from an old step-numbering scheme; never referenced by any script. |
| 5 | `.gitignore` | Added `.superpowers/`, `web-tests/test-results/`, `web-tests/playwright-report/` | Prevent accidental commit of scratch + test output (`.superpowers/` was untracked but not ignored). |

## Deferred — recommended, needs a judgment call or owner decision

**Front-end JS**
- `booking.js` `render()` (~170 lines) mixes DOM writes, pricing, and mode branching — a
  future refactor candidate (extract `renderSummary`/`renderPaymentChoice`). Not urgent;
  well-tested. *(Med)*
- `booking.js:1149` — PayHere handlers (`onCompleted`/`onDismissed`/`onError`) are assigned
  without a `if (window.payhere)` guard; if the PayHere CDN script fails to load,
  `startPayHere` throws. Low likelihood, but a guard would fail more gracefully. *(Med —
  touches payment path, change carefully.)*
- Listener-leak edge cases in `datepicker.js` (open/close) and `image-slot.js` reframe
  listeners if a component unmounts mid-interaction. *(Low)*
- `booking.js:793` money comparison uses a float epsilon (`0.005`) though money is integer
  cents — add a clarifying comment or clamp to integer math. *(Low)*
- `var` → `const/let` modernization in `consent.js` and the shared-ride block of
  `booking.js`; standardize `fmtT`→`fmtTime` (duplicate 24h→12h formatter). *(Low)*

**HTML/CSS**
- Cascade-dead duplicate CSS blocks: `index.html` `.rev` (308-312 superseded by 367-374)
  and `booking.html` `.when-grid` (185-186 superseded by 434-435). Behaviour-preserving
  today (later rule wins) but genuine leftovers — clean by hand after re-checking the
  media-query breakpoints, not by blind delete. *(Low-Med)*
- `manage.html` still packs the error-beacon and the `window.CEYLON_HOP_API` override into
  one `<script>` (every other page keeps them separate). Harmless; split for consistency. *(Low)*
- `index.html:10` favicon is an inline `data:` URI instead of `href="favicon.svg"` like
  every other page. Cosmetic divergence. *(Low)*
- `site.css` — a handful of selectors spot-checked with zero HTML hits; needs a full JS+HTML
  grep before any deletion (class names are also built in JS template strings). *(Low, careful)*

**Backend — observability & validation gaps (highest-value deferred items)**
Backend is otherwise exceptionally clean (`tsc --noEmit` + `eslint` pass, no TODOs/dead
code/`as any`, tidy migrations). But five error paths don't reach the Sentry seam
`track()` or skip validation — worth a dedicated follow-up PR:
- `api/src/routes/ops.ts:118-125` — catch-all reports non-transition errors as a generic
  `illegal_transition` and **bypasses `track()`**; narrow to `instanceof
  IllegalTransitionError` (as `admin.ts` does) so real errors surface in Sentry. *(Med)*
- `api/src/adapters/maps.ts` (`GoogleMapsAdapter`) — all real-adapter failures only
  `console.error`, never `track()`; a **systemic Google Maps outage would be invisible in
  Sentry**. Route them through `track()`. *(Med)*
- `api/src/routes/admin.ts` — best-effort catches (cancel/refund email, concierge-task,
  sweep) log to console only with no `track()`/alert, **inconsistent with `webhooks.ts`**
  which alerts on the identical confirmation-email-failure case. *(Med)*
- `api/src/routes/internalQuote.ts:396-403` — PATCH `/admin/quote/:id` has **no Zod
  validation** on `notes`/`lostReason` (manual `as` cast), unlike every other mutating
  route there. *(Med)*
- `api/src/routes/ops.ts:119,128-132` — uses throwing `.parse()` instead of the codebase's
  dominant `.safeParse()` + friendly-400 convention. *(Low)*

These are all in `api/` (a separate concern from this front-end-focused branch) and touch
error paths, so they belong in their own backend PR with red→green tests — not folded into
the hygiene cleanup.

**Tooling / docs**
- `README.md` still says "no backend / simulated payment" — **actively misleading** now
  that Supabase+PayHere is live and sandbox-verified. Update it. *(High — doc, low risk)*
- `docs/backend-spec.md` / `docs/build-plan.md` are frozen at mid-June dates and miss
  M11–M17; add a "current status" pointer or refresh. *(Med)*
- `.github/workflows/ci.yml` runs only `test:unit` — the e2e specs never run in CI. Consider
  adding a Playwright job. *(Med)*
- `tools/site-chrome.mjs:23` — dead `WA_ICON` constant, safe to remove. *(Low)*
- `_ops-preview.html` is committed at repo root, but `docs/ops-dashboard-status.md` states
  twice that it is "NOT committed to git." Resolve the contradiction: either `git rm` the
  preview (it's an internal mockup, no page links to it) or correct the doc. *Not auto-done
  — deleting a committed file I didn't create warrants an owner decision.* *(High — contradiction, low risk)*
- Stale docs not labelled superseded: `docs/quote-tool-gap-inventory.md` ("nothing built
  yet" — but the quote tool shipped 2026-07-02) and `docs/ops-dashboard-slice-1-*.md`
  (coordinator model, superseded 2026-07-03). Add a one-line "SUPERSEDED by …" banner. *(Med)*
- No `web-tests/README.md` documenting the `CH_E2E_API=1` gate (why 15 e2e tests skip
  without it). *(Med)* — partially addressed by [maintenance-hygiene.md](maintenance-hygiene.md).
- The `seo-codegen` drift guard (regenerate-after-generator-change) was only documented in
  its own file comment — now covered in [maintenance-hygiene.md](maintenance-hygiene.md) §2.

## False positives caught (do NOT "fix" these)

- **`tour.html` canonical → `tours.html`** was flagged as an SEO bug. It is **intentional**
  and test-enforced (`seo-existing-pages.test.js`): `tour.html` is a `?slug`-driven template
  with no single indexable URL, so it canonicalises to the indexed `tours.html`. A "fix"
  broke the test and was reverted.
- **`window.finalizeBooking` export** was flagged as unused. It is **required** — the e2e
  purchase-gating tests call it (`analytics-funnel.spec.js`). Keep it.
- `_ops-preview.html` missing analytics/consent is **intentional** (internal founder mockup,
  not a shipped page).
- `routes-data.js`/`transfers-data.js` price duplication of the backend rate card is an
  **intentional mirror**, covered by the parity guard.

## Not audited deeply / in flux
- `plan.html` / `plan.js` were being edited by a concurrent session during this audit;
  their findings (pricing-helper duplication with `transfers-data.js`, an unwired `#modal`
  block possibly stale from a pre-refactor flow) are marked IN FLUX — re-verify after that
  work lands before acting.

## Method
Four parallel read-only audit agents (front-end, HTML/CSS, backend, tooling) plus a
backend `tsc`/grep pass. Every applied fix was verified against the code and the full suite
(`npm run test:all` → 167 unit + 39 e2e green) after changes.
