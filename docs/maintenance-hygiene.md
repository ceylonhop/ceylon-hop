# Ceylon Hop — Maintenance & Hygiene Guide

**Purpose:** what to remember when changing this codebase so quality doesn't rot. Read this
before adding a page, a funnel step, a route, or a price. It complements — does not
replace — `CLAUDE.md` (the agent operating contract, which carries the backend rules) and
the `docs/` specs (`backend-spec.md`, `build-plan.md`).

Last reviewed: 2026-07-05.

---

## 1. Repo map

| Area | What | Key rule |
|------|------|----------|
| Root `*.html`, `*.js`, `site.css` | Static marketing + booking site (vanilla JS, **no build step**) | Edit directly; keep changes covered by `web-tests/` |
| `tools/*.mjs` | Node generators for SEO route pages + legal/404 pages | Output is committed; **regenerate after changing inputs** (§2) |
| `api/` | Backend (Node 20, TS strict, Hono, Zod, Drizzle+Postgres) | One-step-one-PR, TDD, money = integer minor units + USD |
| `web-tests/` | Vitest unit + Playwright e2e | `npm run test:all` must be green before a PR |
| `docs/` | Specs (`docs/superpowers/specs/`), plans (`.../plans/`), runbooks | Label superseded docs; keep the go-live checklist current |

---

## 2. Generated vs hand-authored pages — the #1 gotcha

**Hand-authored** (edit directly): `index, booking, search, plan, about, blog, why, tours,
tour, manage` (`.html`).

**Generated** (DO NOT hand-edit — they are overwritten): `terms.html`, `privacy.html`,
`404.html`, everything under `trip/`, `sitemap.xml`, and the redirect stubs. Their content
comes from `tools/generate-*.mjs` + `tools/site-chrome.mjs` (`headAssets`) + the source
fragments in `tools/legal/*.body.html`.

**The rule:** if you change `headAssets`, a generator, or a `tools/legal/*` fragment, you
MUST run `npm run generate` (repo root) and commit the regenerated files in the same PR.
The drift guard `web-tests/unit/seo-codegen.test.js` fails if committed output ≠ generator
output — that red test is telling you to regenerate.

---

## 3. When you add or change X, also do Y

### Adding a new **page**
A page's `<head>` must carry, in this order (see any hand-authored page or `headAssets` in
`tools/site-chrome.mjs`):
1. `charset`, `viewport`, `title`, `description`, `canonical`
2. **`robots` — add `noindex` for any transactional or private page** (booking/search/tour
   are `noindex`; `manage.html` is `noindex, nofollow` because it renders a customer's
   booking by token). Marketing/content pages stay indexable.
3. `theme-color`, `favicon`, OG tags, stylesheet
4. **Analytics + consent snippet** (consent-defaults `<script>` → GTM loader → `analytics.js`
   (sync) → `consent.js` (defer)) — byte-identical to `analyticsSnippet` in
   `tools/site-chrome.mjs`.
5. **Error beacon** `<script>` (the `errorBeaconSnippet` IIFE).
6. Page-specific scripts last.

Then: add the page to the relevant guard tests
(`web-tests/unit/analytics-snippet.test.js`, `seo-existing-pages.test.js`,
`seo-error-beacon.test.js`). If the page is generated, it inherits all of the above from
`headAssets` — add it to the generator, don't hand-write it.

### Adding a new **funnel step / tracked user action** (analytics)
- Fire `window.chTrack('event_name', { ...params })`, **guarded**:
  `if (typeof window.chTrack === 'function') window.chTrack(...)`.
- Use GA4-shaped names and the shared `items[]` shape (see
  `docs/superpowers/specs/2026-07-05-analytics-funnel-instrumentation-design.md`). Money
  events carry `currency: 'USD'` and `value` from the real total (`calcTotal()`), never a
  hardcoded number.
- **Revenue events** (`purchase`) must also be gated on `window.chIsProd()` so
  sandbox/localhost/Pages traffic never pollutes GA4.
- Add the event to the GTM container checklist
  (`docs/analytics/gtm-container-checklist.md`) — until a GTM tag consumes it, the event
  fills `dataLayer` but reaches no dashboard.
- Add an e2e that asserts the event appears in `window.dataLayer` (see
  `web-tests/e2e/analytics-funnel.spec.js`).

### Adding a new **backend route / async path** (errors + Sentry)
- Unhandled exceptions already reach Sentry: `app.onError` (`api/src/app.ts`) calls
  `track(err, { route })` (the single Sentry seam, `api/src/observability/track.ts`) **and**
  emails the founder a critical alert. You get this for free — **don't swallow errors** in a
  `try/catch` that hides the failure; if you must catch, forward to `track()` or
  `alerts.send()`.
- Validate input with **Zod** at the edge; return typed errors, not thrown strings.
- Front-end JS errors auto-beacon to `POST /errors/client` (every public page carries the
  beacon) → Sentry tagged `frontend` + founder alert. A new hand-authored page MUST include
  the error beacon (generated pages get it via `headAssets`).
- Sentry is **errors only** (`tracesSampleRate: 0`) and dormant unless `SENTRY_DSN` is set
  (active in prod). It does not track analytics — that's GTM/GA4. Session replay is Clarity.

### Changing a **price / rate / corridor**
- The backend is canonical: `api/src/quote/rateCard.ts` + the corridor seat prices in
  `api/src/db/departureRepo.ts`. Since the 2026-07-09 codegen change, the front-end
  `routes-data.js` / `transfers-data.js` price blocks are **generated** from the rate card
  (the `@generated:pricing` regions) — do **not** hand-edit them.
- Edit `rateCard.ts` (and/or `departureRepo.ts`), then run `npm run generate` (repo root; or
  `npm run generate:pricing`) and commit the regenerated blocks in the same PR. The parity
  guards (`web-tests/unit/shared-price-parity.test.js`, `web-tests/unit/backend-price-parity.test.js`,
  and the backend `pricing.test.js`) verify the mirror. Money is integer minor units + USD on
  the backend; the front-end formats for display only.

### Adding a **new tracking vendor or cookie**
- Update the consent grants in `consent.js` and the disclosure in
  `tools/legal/privacy.body.html` (then regenerate — privacy.html is generated), and add
  the tag to the GTM checklist. Consent defaults are **denied** until the banner is
  accepted; keep it that way.

### Touching **/ops** (founder tooling)
- Respect the founder / finance / ops RBAC roles and the founder-only gating already in
  place. Ops routes are auth-guarded — register new ones **after** the guard middleware.

---

## 4. External services & secrets

- PayHere, Google Maps, and email are reached only through an **adapter with a fake**
  (`api/src/adapters/*`). Real swaps are their own labelled steps; tests never hit real
  services.
- **Secrets live only in `api/` env** (`GA4_MP_API_SECRET`, `META_CAPI_TOKEN`,
  `PAYHERE_MERCHANT_SECRET`, `SENTRY_DSN`, DB URL…). The front-end may contain **only
  publishable IDs** (GTM `GTM-NL6K22CM`, GA4 `G-XEW62ZD7B3`, Clarity, Pixel, Ads, the
  referrer-restricted Maps key). Never put a secret in a `*.html`/`*.js` served to browsers.

---

## 5. Observability quick reference

| Signal | Tool | Fires on |
|--------|------|----------|
| Crashes / bugs | **Sentry** (errors only) | Backend 500s (`app.onError`) + front-end uncaught JS (`/errors/client` beacon) |
| Founder alerts (email) | `alerts` adapter | API errors, client errors, confirmation-email failures |
| Funnel / conversions | **GA4 via GTM** | `chTrack` events (search → … → purchase) |
| Session replay / rage-clicks | **Microsoft Clarity** | All pages (via GTM, consent-gated) |

Sentry = "did it break." GA4 = "what did users do." Clarity = "watch them do it." They
don't overlap.

---

## 6. Pre-PR checklist

- [ ] `cd web-tests && npm run test:all` green (unit + e2e).
- [ ] `cd api && npm run check` green (typecheck + lint + tests) if you touched `api/`.
- [ ] If you changed `headAssets` / a generator / a `tools/legal` fragment → `npm run
      generate` and committed the regenerated pages (drift guard).
- [ ] New page carries: correct `robots`, analytics snippet, `consent.js`, error beacon.
- [ ] New tracked action: guarded `chTrack`, prod-gated if revenue, added to GTM checklist + an e2e.
- [ ] Price change mirrored front-end ↔ backend and parity guard passes.
- [ ] No secrets added to front-end; no swallowed errors added to backend.
- [ ] Branch off `main`; one focused concern per PR.
