# Quote Tool UI Port — Design (qgen generator onto the server engine)

**Date:** 2026-06-30
**Status:** approved for planning
**Milestone:** M11 (front-end rebuild of the internal quoting tool; follows the engine PR #2, tool PR #3, and the quote-lifecycle branch)

## Goal

Rebuild the internal quoting tool (`api/src/routes/quote-tool.html`) to **be** the owner's designed
"Ops · Quote Generator" (extracted verbatim in `docs/qgen-design-extraction.md`), wired to the
**server engine** for all pricing and to the **lifecycle endpoints** for save/list/status — replacing
the design's in-browser `CH.compute` and `localStorage`.

## Why (what was wrong)

The shipped tool was a thin hand-rolled page with a redundant top-level "Service" dropdown layered on
per-leg "Leg type", missing the Settings, Flags, timeline, stopovers, driver/car-stay, fees, notes, and
output tabs the owner designed. This port makes the tool the real designed UI, driven by the
server-authoritative engine.

## Locked decisions

| # | Decision |
|---|---|
| P1 | **Port the qgen design 1:1** (its CSS, header, six cards, timeline) in **vanilla JS** — no React/Babel runtime, so it stays a single server-served file. |
| P2 | **No separate "Service" control.** transfer-vs-chauffeur is **derived from the legs** (any `stay_day`, `hasDriver`, or `hasCarStay` ⇒ chauffeur; else private). |
| P3 | **Engine is the price.** All money comes from `POST /estimate`; the design's `CH.compute`/`estimateRoute`/`legPrice` are dropped. |
| P4 | **Rate Settings card = read-only** display of the locked engine rate card. No admin-unlock/editing. |
| P5 | **Summary reflects the engine's structure** (day-rate / travel / idle / extras + deposit), styled in the design's look — not the design's editable driver-bata-accommodation build-up. |
| P6 | **Statuses = backend set** (`draft/sent/won/lost/expired`) shown with friendly labels (Draft / Sent / Booked / Lost / Expired). The design's "Ready to Send" is dropped. |
| P7 | **Vehicle tiers:** Car + Van 6 price via the engine now. Van 9 / Van 14 / Custom render but are **pricing-gated** ("rate needed") until per-km rates are provided. |
| P8 | **No core-engine change.** The UI breakdown (km strip, per-leg prices) is computed in a new mapping layer from the engine's already-exported primitives; the reviewed `quote()` result shape is untouched. |
| P9 | **Lifecycle** save/list/status use the existing `/save`, `/list`, `/patch` (from the quote-lifecycle branch this builds on). |

## Model mapping (the logic)

### Design `quote`/`leg` → engine `QuoteRequest`

**Product (P2):** `chauffeur` if any leg has `category === 'stay_day'` OR `hasDriver` OR `hasCarStay`; else `private`.

**Vehicle:** `car → car`; `van_6 → van`; `van_9 / van_14 / custom →` **gated** (P7) — the tool does not
call `/estimate` for these; it shows a "rate needed" note. (When rates arrive, they map to new engine
vehicle classes — out of scope here.)

**Driving legs** (`CATEGORIES` with `drives:true` = transfer, airport, train_support, sightseeing,
safari_wait): each becomes an engine leg `{ from: pickupLocation, to: dropoffLocation, distanceKm }`.
`stay_day` legs do not drive.

**Extras** (collected across legs; duplicates allowed = one per toggled leg):
- `leg.addSightseeingFee` ⇒ `'sightseeing'`
- `leg.addWaitingFee` ⇒ `'waiting'`
- `leg.category === 'safari_wait'` ⇒ `'safari-wait'`
- The design's editable per-leg fee **amounts are ignored** — the engine's flat extra value is authoritative (P3/P5). The fee shows the engine amount, read-only.

**Private request:** `{ product:'private', vehicle, pax:passengerCount, bags:luggageCount, legs:[…], extras:[…] }`.

**Chauffeur request:** `{ product:'chauffeur', vehicle, firstDate, lastDate, travelDays:[{date,from,to,distanceKm}], extras:[…] }`
where `firstDate`/`lastDate` are the min/max leg dates and `travelDays` are the driving legs. Idle days
are derived by the engine from the date span. `hasDriver`/`hasCarStay`/bata/accommodation do **not** map to
separate charges — the engine's `$35/day` covers driver cost (P5); those toggles only mark the trip as
chauffeur and set the date span.

### Design `quote` → `/save` payload

`{ name:customerName, contact:<a new contact field>, product, vehicle, pax, bags, legs:[…], notes:internalNotes }`
plus the extras — i.e. the same `ToolRequest` shape `/save` already re-prices server-side. The saved
`request_json`/`result_json` remain the engine's authoritative I/O.

## Engine/API additions (additive, no core-engine change — P8)

1. **UI breakdown helper** `quoteBreakdown(req, result)` (new, in the quote module) returns, computed from
   the engine's pricing primitives (`billableKm`, `legPriceCents`, `perKmCents`, `floorCents` — exposing
   them at the quote module's top level if they are not already exported):
   - `km: { distanceKm, bufferKm, billableKm }` (totals across driving legs)
   - `legs: [{ from, to, distanceKm, billableKm, priceCents }]` (per driving leg; for chauffeur these are the travel legs)
   Unit-tested against known values (e.g. 140 km van).
2. **`/estimate` response superset:** add `breakdown` (the above) and keep everything it already returns
   (total, deposit, amountDueNow, margin, warnings, lineItems, fxUsdToLkr, comparison, drafts).
3. **Rate-card exposure for the read-only Settings:** `/estimate` (or a small `GET /admin/quote/rate-card`)
   returns the display rate card — `perKmCents{car,van}`, `floorCents{car,van}`, chauffeur `dayRateCents`,
   `bufferPct`, `deposit`, `extras`, `fxUsdToLkr`, `version`. The Settings card renders these read-only.

## Flags (design §4)

Computed **client-side** for pure-UI flags (no pricing needed): car-luggage-limit, capacity, airport-timing,
stopover-included, long-drive (needs drive-time — from `/distance` duration), hectic-itinerary (3+ consecutive
dated driving legs), driver-without-car, safari-waiting. **Engine warnings** (`result.warnings`, e.g.
vehicle-upgrade / floor-applied) are merged in as additional flags. "Check distances" fires when a driving
leg has no resolvable distance.

## Output templates (design §5)

Port `whatsappMessage` / `emailMessage` / `notionTable` **client-side**, built from the priced result +
itinerary (they match the server drafts already generated — same copy). Per-leg rows use the breakdown's
per-leg prices; currency toggle (LKR/USD) converts at the rate card's `fxUsdToLkr` for display only. The
server draft generators can remain for API callers but the tool renders its own live tabs.

## What is dropped / deferred

- `CH.compute`, `CH.estimateRoute`, `CH.legPrice`, editable rate settings, admin-unlock, "Ready to Send",
  localStorage autosave (server `/save` replaces it), the design's per-leg fee **amounts**.
- Van 9 / Van 14 / Custom **pricing** (gated) — pending rates.
- The design's `outputCurrency` persists per quote (kept — display-only toggle).

## Testing

- **Unit:** `quoteBreakdown` (km totals + per-leg prices) against known values; model mapping
  (`toEngineRequest` extended for categories/stays/fees/vehicle tiers, and the product-derivation rule);
  save payload mapping; rate-card exposure shape.
- **Route:** `/estimate` returns `breakdown`; gated vehicles rejected/gated; chauffeur derivation from legs.
- **Browser e2e (Playwright):** build a 2-leg itinerary via the timeline (category, autocomplete, auto-distance),
  add a stay day (⇒ chauffeur), see the Summary + per-leg prices + Flags, switch output tabs, Save → reference
  in Recent, change status. Keep the offline-known-places path so it runs without a Google key.

## Rollout

Front-end + additive API only; no schema change, no core-engine change. The current thin `quote-tool.html`
is replaced wholesale. Deferred/go-live items (ADMIN_API_KEY, van rates) carry forward.
