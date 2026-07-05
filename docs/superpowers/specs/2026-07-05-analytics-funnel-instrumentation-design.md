# Analytics & Funnel Instrumentation — Design

**Date:** 2026-07-05
**Status:** Approved (brainstorming) → ready for implementation plan
**Owner:** Roshen

## 1. Problem & context

Ceylon Hop runs **two sites**:

- **Apex `ceylonhop.com`** — the legacy WordPress + Elementor marketing site. It already
  carries a full analytics stack, all inside one GTM container:
  - GTM container `GTM-NL6K22CM`
  - GA4 `G-XEW62ZD7B3`
  - Google Ads `AW-16942077888`
  - Meta Pixel `656008603498739`
  - Microsoft Clarity `qrhbzsb6w8`
- **The redesigned static app** (this repo) — the actual booking funnel
  (`index.html` → `search.html` → `booking.html` → PayHere → confirmation). It has
  **zero third-party analytics**. Only a client error beacon (`/errors/client`) and
  dormant backend Sentry exist.

Per the M16 SEO migration, the redesigned app will **replace the apex domain**. When that
happens, all historical tracking (which only ever measured WordPress pageviews) becomes
useless, and the funnel that actually converts customers has never been measured.

**This project ports the existing GTM stack onto the redesigned app and builds the
end-to-end conversion funnel events that have never existed anywhere.**

No new accounts are created. We **reuse** the existing GTM container and GA4 property so
new funnel data lands alongside historical data (decision confirmed 2026-07-05).

## 2. Goals / non-goals

**Goals**
- One shared analytics snippet on every page of the redesigned app, driven by the
  existing `GTM-NL6K22CM` container.
- A deterministic, code-driven funnel event schema (`view_item_list` → `purchase`) that
  powers GA4 funnel reports, Google Ads conversions, and the Meta Pixel from one source.
- **Reliable purchase conversions**: fire `purchase` both client-side (fast attribution)
  and server-side from the PayHere webhook (accurate even when the tab closes), deduped by
  booking reference.
- **Consent Mode v2** + a lightweight consent banner, so EU/UK visitors are handled
  compliantly and Google Ads/GA data stays usable.
- Zero regressions to the existing Vitest/Playwright suites; tracking is fully no-op when
  GTM/consent are absent (test + local dev stay clean).

**Non-goals**
- No new analytics platform (no PostHog/Mixpanel/Amplitude/Segment).
- No redesign of the booking flow itself — we instrument what exists.
- No change to the legacy WordPress site (it is being retired by M16).
- Backend product analytics warehouse / custom event DB — out of scope; GA4 is the store.

## 3. The funnel (event schema)

Booking is driven by `booking.js` `goStep(n)` over 4 panels, fed by the homepage quote
form and `search.html`. Events map to **GA4 recommended ecommerce events** so GA4's
built-in funnel exploration, Ads conversion import, and Meta Pixel all consume one schema.

Currency is **USD** across the pricing engine (`rateCard.ts`, `types.ts`); all monetary
events use `currency: 'USD'`.

**The funnel starts at the landing page**, not at checkout. A visitor's path is
Landing → Search → Results → Select → Checkout(×4 steps) → Purchase. Entry is not only the
homepage: people also land directly on route/SEO pages (`/trip/...`) and tour pages, so
step 1 is a landing view on **any** entry surface and step 2 is the first search intent.

| # | Stage | Fires from | GA4 event | Params |
|---|-------|-----------|-----------|--------|
| 1 | Landing / any page view (funnel entry) | GTM auto on every page (`session_start` marks the entry) | `page_view` | page_location, page_referrer, landing_type (home/route/tour/other) |
| 2 | Route searched | `index.html` hero form submit **or** a route/tour page CTA into search | `search` | from, to, date, pax, source (home/route/tour) |
| 3 | Results shown | `search.html` render (private + shared cards) | `view_item_list` | item_list_id=route, items[] |
| 4 | Option chosen | click a result card → booking | `select_item` | mode (private/shared/trip) |
| 5 | Enter checkout | `booking.html` load | `begin_checkout` | value, currency, items[] |
| 6 | When complete | `booking.js` step 1 → 2 | `checkout_progress` `{checkout_step:'when'}` | date, flex_date, flex_time |
| 7 | Where complete | step 2 → 3 | `checkout_progress` `{checkout_step:'where'}` | pickup, dropoff |
| 8 | Travelers complete | step 3 → 4 | `checkout_progress` `{checkout_step:'pax'}` | adults, children, bags |
| 9 | Payment info | step 4: plan chosen + contact valid | `add_payment_info` | payment_type (full/deposit) |
| 10 | PayHere opened | `runPayment()` | `payment_initiated` | value, currency, payment_type |
| 11 | **Purchase** | PayHere `onCompleted` **and** server webhook | `purchase` | transaction_id=reference, value, currency, payment_type, items[] |
| — | Abandon at pay | PayHere `onDismissed` | `payment_dismissed` | reference |
| — | Payment error | PayHere `onError` | `payment_failed` | reference, reason |
| — | Reprice shown | `booking.js` reprice note render | `reprice_shown` | extra_km, delta |
| — | Reprice accepted | `acceptReprice()` | `reprice_accepted` | extra_km, new_value |

**`items[]` shape** (shared across `view_item_list`/`select_item`/`begin_checkout`/`purchase`):
```
{ item_id: <route slug>, item_name: "<From> → <To>",
  item_category: private | shared | trip,
  item_variant: car | van | van9 | van14 | custom,
  price: <per-unit USD>, quantity: <pax> }
```

**Reported funnels** (built in GA4 Funnel Exploration off these events):
- **Macro / end-to-end** = 1 → 11: `page_view` (landing) → `search` → `view_item_list` →
  `select_item` → `begin_checkout` → `checkout_progress`×3 → `add_payment_info` →
  `payment_initiated` → `purchase`. This is the headline conversion rate from a visitor
  landing to a paid booking.
- **Checkout sub-funnel** = 5 → 11, for diagnosing drop-off *inside* the booking form.
- **Business branches:** **deposit-vs-full split** (`payment_type` on 9/10/11) and
  **reprice acceptance** (`reprice_shown` → `reprice_accepted`).

Because entry surfaces differ (home vs route vs tour page), the macro funnel's step 1 is
"any landing `page_view`" and step 2 accepts `search` from any source — GA4's
"is one of / any" step matching handles the multiple on-ramps. `landing_type` / `source`
params let you segment conversion by entry surface (e.g. SEO route pages vs homepage).

## 4. Architecture

Three units, each independently understandable and testable.

### 4.1 Shared analytics snippet (page load)
- **What:** Consent Mode v2 defaults (`analytics_storage`, `ad_storage`, `ad_user_data`,
  `ad_personalization` = `denied`; `wait_for_update`) → GTM loader (`GTM-NL6K22CM`) →
  `<noscript>` GTM iframe in body.
- **Where injected:** `tools/site-chrome.mjs` `headAssets()` covers every generated page;
  the hard-coded root pages (`index.html`, `booking.html`, `plan.html`, `search.html`,
  `about.html`, `blog.html`, `why.html`, `tours.html`, `tour.html`, `privacy.html`,
  `terms.html`, `manage.html`, `404.html`) get the same snippet. To avoid drift, the
  snippet is authored **once** as an exported string in `site-chrome.mjs`
  (mirroring the existing `errorBeaconSnippet` pattern) and the root pages include it via
  the same generator path where possible; where a page is fully hand-authored, the string
  is copied verbatim and covered by a build-time guard test (§6).
- **Clarity:** loaded **as a GTM tag** (not hard-coded), so it is gated by the same consent
  signal. Project `qrhbzsb6w8`.
- **Ordering:** Consent defaults MUST execute before the GTM loader, and both before any
  `chTrack` call, so early events queue in `dataLayer` and replay after consent resolves.

### 4.2 `analytics.js` — the `chTrack` helper (funnel events)
- **What:** a tiny module exposing `window.chTrack(event, params)` that pushes
  `{ event, ...params }` onto `window.dataLayer` (creating it if absent).
- **Why code, not GTM triggers:** the funnel steps live in JS state transitions
  (`goStep`, `runPayment`, `acceptReprice`), not stable DOM/CSS. Firing explicitly from
  code makes the funnel deterministic, greppable, and unit-testable, and avoids brittle
  GTM CSS-selector triggers that silently break on a markup change.
- **No-op safety:** if `dataLayer`/GTM is absent (tests, local dev, consent denied), the
  push is harmless and events simply buffer or are dropped by GTM. No throw, ever.
- **Call sites:** `index.html` quote form (2), `search.js` (3, 4), `booking.js`
  (5–11 + dismissed/failed/reprice). One thin call per transition; no business logic moves.

### 4.3 Server-side purchase confirmation (conversion integrity)
- **Insertion point:** `api/src/routes/webhooks.ts`, `POST /payments`, the block where
  `booking.status === 'payment_pending'` → `bookings.setStatus(id, 'paid')` (already
  idempotent — a duplicate webhook returns early at the `payment.status === 'succeeded'`
  guard). This is the single authoritative "money received" event.
- **What it sends** (best-effort, never blocks the paid/confirmation path):
  - **GA4 Measurement Protocol** `purchase` — `transaction_id = booking.reference`,
    `value`, `currency:'USD'`, `items[]`, `payment_type`.
  - **Meta Conversions API** `Purchase` — same `event_id = reference`.
  - **Google Ads** enhanced/offline conversion keyed on `reference` (phase-gated; see plan).
- **Dedup:** client and server both use `reference` as `transaction_id`/`event_id`; GA4
  and Meta dedupe on it, so a purchase counted once whether or not the client fired.
- **Failure posture:** wrapped like the existing confirmation email — a send failure logs
  and raises an ops alert but never changes booking state. Reuses the dormant-when-unset
  env pattern (`GA4_MP_API_SECRET`, `META_CAPI_TOKEN`, etc. absent → no-op).

### 4.4 Consent banner + privacy
- Lightweight banner (no third-party CMP): Accept / Reject / (optional) Manage.
  On Accept → `gtag('consent','update',{analytics_storage:'granted',ad_storage:'granted',
  ad_user_data:'granted',ad_personalization:'granted'})` and Clarity consent; choice stored
  in `localStorage` (`ceylonhop_consent`), no server round-trip.
- Region hint optional; default banner shows to all, defaults stay `denied` until choice —
  compliant for EU/UK without geo-blocking.
- Update `privacy.html` to disclose GA4/Clarity/Ads/Meta cookies, purpose, and opt-out.

## 5. GTM container configuration (done in the GTM UI, documented in the plan)

Inside `GTM-NL6K22CM`, add (all gated by a Consent Mode check / consent-initialization
trigger):
1. **GA4 Configuration** tag → `G-XEW62ZD7B3`.
2. **GA4 Event** tags for each custom `dataLayer` event in §3 (Custom Event triggers on
   `search`, `view_item_list`, `select_item`, `begin_checkout`, `checkout_progress`,
   `add_payment_info`, `payment_initiated`, `purchase`, `payment_dismissed`,
   `payment_failed`, `reprice_shown`, `reprice_accepted`), forwarding the params via
   dataLayer variables.
3. **Google Ads Conversion** tag on `purchase` → `AW-16942077888` (value + currency + txn).
4. **Meta Pixel** base + `Purchase` custom-HTML/template tag → `656008603498739`.
5. **Microsoft Clarity** tag → `qrhbzsb6w8`.

GA4 property: mark `purchase` as a key event; register custom dimensions `payment_type`,
`checkout_step`, `item_category`. This is config, not code — the repo carries a
`docs/` checklist, not container JSON, but a container export (`GTM-NL6K22CM.json`) is
committed to `docs/analytics/` for reference/versioning.

## 6. Testing

- **Unit (Vitest, `web-tests/`):** `chTrack` pushes the right shape; no-ops without
  `dataLayer`; each funnel transition in `booking.js`/`search.js` calls `chTrack` with the
  expected event+params (spy on `window.dataLayer.push`).
- **Guard test:** the analytics snippet string is present and identical across all root
  HTML pages + `site-chrome.mjs` output (prevents per-page drift).
- **Server (api tests):** webhook `POST /payments` on first success triggers the MP/CAPI
  senders exactly once; a duplicate webhook does not re-send (idempotency); senders are
  no-ops when secrets are unset; a sender throw does not change booking status or block the
  confirmation email.
- **E2E (Playwright):** drive a sandbox booking; assert the ordered `dataLayer` sequence
  `begin_checkout → checkout_progress×3 → add_payment_info → payment_initiated → purchase`;
  assert consent-denied state suppresses tag network calls until Accept.
- Run `npm run test:all` green before merge (per project test policy).

## 7. Rollout / sequencing

1. Ship `chTrack` + funnel call sites + the shared snippet + consent banner + privacy
   update (client), behind the existing container — verify events in GA4 DebugView.
2. Add server-side MP/CAPI senders on the webhook; verify deduped `purchase` in GA4.
3. Configure GTM tags (GA4 events, Ads, Meta, Clarity) + GA4 key-event/custom dims.
4. Google Ads enhanced-conversions wiring (server) once 1–3 are verified.
- This is **pre-apex-cutover** work; the M16 migration inherits a fully instrumented app,
  so no measurement gap at cutover.

## 8. Risks & mitigations

- **Snippet drift across hand-authored pages** → single-source string + guard test (§6).
- **Client purchase missed** (tab close/redirect) → server-side webhook send is the source
  of truth; client is best-effort (§4.3).
- **Double-counting** → shared `reference` as transaction/event id; GA4+Meta dedupe.
- **Consent blocking data** → Consent Mode v2 still sends cookieless pings (modeling);
  acceptable and compliant.
- **Secrets in a static/front-end context** → only publishable IDs (GTM, GA4 measurement
  id, Pixel id) live client-side; MP API secret, CAPI token, Ads developer token live
  **only** on the API (`api/` env), never in the repo or front-end.

## 9. New env vars (API, all dormant-when-unset)

- `GA4_MEASUREMENT_ID` (`G-XEW62ZD7B3`), `GA4_MP_API_SECRET`
- `META_PIXEL_ID` (`656008603498739`), `META_CAPI_TOKEN`
- `GOOGLE_ADS_*` (phase 4)

## 10. Open items for the go-live checklist

- Add GA4/Clarity/Ads/Meta to the privacy policy before real traffic (ties into existing
  go-live checklist).
- Confirm PayHere `notify_url` is set in prod so the server-side purchase actually fires.
