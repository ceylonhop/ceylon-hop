# Rate-card hot zones — design (DRAFT for owner review)

**Status:** proposal only. No code written. Owner asked (2026-07-22) to *design, critique, and commit a plan* for later review.
**Revised 2026-07-22** after owner discussion: **D3** matching is now **name-first** (against the known-places list) with the geo-radius demoted to an optional fallback; **D9** the premium is **founder-only** (rides the existing `margin:view` gate — hidden from ops *and* the customer). Sections 4, 5, 6, 10, 11, 12 updated to match.
**Guardrail:** this touches pricing. Per CLAUDE.md ("STOP and ask before touching pricing"), nothing here ships without an explicit owner go on this doc.

## 1. Goal (owner, 2026-07-22)

> "Create a hot zone for the rate card. If a certain list of cities/towns are searched and we calculate rates, boost the rate by X%. Founder-editable, and it applies to **all** rates generated in ops **and** the website."

A *hot zone* is a premium area (e.g. a resort town, a festival hotspot, a hard-to-service region). When a trip touches one, its price goes up by a founder-set percentage. The list of zones and their percentages are the founder's to change, and the change must flow through **both** pricing surfaces at once: the ops quote tool and the generated website prices.

## 2. Where prices are computed today (the surfaces a boost must reach)

Backend is the single source of truth for pricing ([[ceylon-hop-pricing-source-of-truth]]).

| Product | Function | File | Basis |
|---|---|---|---|
| Private (per leg) | `legPriceCents()` / `quotePrivateLegs()` | `api/src/quote/private.ts:16` | `max(floor, km × perKmCents)` — has `leg.from` / `leg.to` |
| Chauffeur | `quoteChauffeur()` | `api/src/quote/chauffeur.ts` | day rate + `billableKm × perKmCents` |
| Shared | `quoteSharedLegs()` + `CORRIDOR_ROUTES` | `api/src/quote/shared.ts`, `departureRepo.ts` | fixed per-seat corridor price (NOT per-km) |
| Orchestration + final rounding | `quote()` → `finishPrice()` | `api/src/quote/engine.ts:23`, `:99` | applies price-finishing once, after the core calc |
| **Website** (generated, not live) | `tools/generate-pricing.mjs` → `routes-data.js`, `transfers-data.js`, `trip/*/index.html` | run via `npm run generate`; parity-guarded by `web-tests/unit/*-price-parity.test.js` |

Two hard constraints fall straight out of this table:

- **C1 — one engine, two emitters.** A boost implemented in the engine (`private.ts` / `chauffeur.ts`) is automatically correct for ops *and* for the website, **provided the website codegen calls the same engine with the same zone data**. The generator must read zones from the same place the engine does; hand-editing `routes-data.js` is forbidden (parity tests fail — [[ceylon-hop-pricing-source-of-truth]]).
- **C2 — rate-lock.** An approved quote is priced against a *locked snapshot* of the rate card ([[ceylon-hop-rate-lock]], `RateCard` type in `rateCard.ts`). If zones aren't part of that snapshot, a locked quote would silently re-price when the founder later edits a zone. **Zones must live inside the `RateCard` snapshot** so a locked quote keeps the zones it was priced with.

## 3. Design decisions

### D1 — What does "boost the rate" mean? → per-leg multiplier on the per-km price
Options: (a) bump `perKmCents`; (b) multiply the leg's *price*; (c) surcharge the whole quote if any leg touches a zone.
**Recommend (a): multiply the per-km rate for a leg whose endpoint is in a zone**, i.e. `rate → rate × (1 + boost)`, then `max(floor, km × boostedRate)` as today. Rationale: localizes the premium to the affected leg, reads naturally in the existing line item, and keeps the floor as a protection. A multi-leg trip where only one leg touches Ella is only boosted on that leg — which is what "boost the rate for that area" should mean.

### D2 — Which endpoint counts? → origin OR destination
A leg `from → to` is "in a zone" if **either** endpoint is in a zone. (You pay the premium whether you're going *to* Ella or coming *from* it.) Flag for owner: is a *pass-through* (neither endpoint, but the route crosses a zone) in scope? **Recommend no** for v1 — endpoint-only is predictable and cheap; pass-through needs the polyline, which we don't always have.

### D3 — How is a location matched to a zone? → name-first (known-places), geo-radius as optional fallback
**Decided 2026-07-22 (owner):** match on the **town name**, not a pin+radius.

What we get from Google today ([`api/src/adapters/maps.ts`](../../../api/src/adapters/maps.ts)): **Distance Matrix** (road distance) + **Places Autocomplete** (display-name *strings* like "Ella, Sri Lanka" — 6 of them). We do **not** currently fetch the structured `locality`/`address_components` a Geocoding/Place-Details call would give. But we do keep a curated **`KNOWN_PLACES`** list (SL town names → coordinates) that the ops autocomplete and every website route are built from.

**Recommend name-first against `KNOWN_PLACES`:** a zone *is* a known town name (the founder picks it from the same list the tool autocompletes from), and a leg endpoint is "in the zone" when its resolved name equals that town (case-insensitive; exact for a known place, word-boundary contains for a free-typed display string). This is **simpler for the founder** (tick which towns are hot — no pins, no radius), **exact** (no "Bella matches Ella" substring trap, because we match the *resolved* place, not raw text), and needs **zero new Google calls**.

Keep the **geo-radius (haversine) as an optional fallback** for the one case name-matching misses: an exact GPS pickup that sits near a hot town but that Google labels as a *neighbouring* village. A zone may carry an optional `{ lat, lng, radiusKm }`; when set, an endpoint with coordinates within that circle also matches. Skip it unless a zone needs it.

Caveat (see R2): name-first trusts the label. If an operator free-types an establishment and Google returns the *venue* name rather than the town, a pure name match can miss it — that's exactly when the optional radius earns its keep.

### D4 — Where do zones live + how does the founder edit them? → new `pricing_zones` table + founder admin
Founder-editable ⇒ database, not a code constant. There is **no founder rate-card admin API today** — it's a documented deferred item (`internalQuote.ts` comment "when the deferred founder rate-card API lands"). This feature can be its **first slice**: a small, self-contained `pricing_zones` CRUD, gated by `quote:approve` (founder-only — `opsAuth.ts`), surfaced in the existing founder-only Rate Settings modal (`renderRateCardBody()`, already `margin:view`-gated).
Zone shape (name-first, per D3): `{ id, place_name, boost_pct, active, lat?, lng?, radius_km?, created_at, updated_at }` — `place_name` is the match key; `lat/lng/radius_km` are the optional geo fallback.

### D5 — How do zones reach the engine + the snapshot? → fold into the `RateCard` object
Add an optional `hotZones?: HotZone[]` to the `RateCard` type (`rateCard.ts`). The live card composes `RATE_CARD` + `activeZones()` from the DB at request time; a **locked** quote carries the zones it was priced with inside its `rate_card_json` snapshot (satisfies C2 automatically, because the snapshot already round-trips the whole `RateCard`). Legacy snapshots with no `hotZones` behave exactly as today (no boost) — same back-compat pattern `priceFinishing?` already uses.

### D6 — Floor & price-finishing interaction → boost the rate, floor still protects, finish still runs last
`legPriceCents` becomes `max(floor, round(km × rate × (1 + boost)))`. The boost lifts the per-km component; a leg still below the floor after boosting is charged the floor (boost simply had no room to apply). `finishPrice()` continues to run once at the end, unchanged. The boost is **pure margin** (cost is unchanged), so `marginEstimateCents` rises correctly with no cost-side edit.

### D7 — Stacking → at most one zone per leg (the max applicable)
If both endpoints hit zones, or a zone overlaps another, apply a **single** boost = the largest applicable `boost_pct`, never the sum. Keeps prices predictable and prevents a runaway double-charge from overlapping radii.

### D8 — Shared corridors → out of scope for v1
Shared is a fixed per-seat corridor price, not per-km — a per-km multiplier doesn't map onto it. **Recommend v1 = private + chauffeur only.** If the owner wants shared boosted too, that's a separate mechanism (a per-corridor multiplier) and should be its own decision.

### D9 — Visibility → founder-only, via the existing `margin:view` gate
**Decided 2026-07-22 (owner):** the premium (the "buffer") is visible to the **founder only** — not to ops/finance, not to the customer. This needs **no new permission**: it maps onto the existing **`margin:view`** capability, which is already founder-only (`opsAuth.ts` — finance/ops don't have it), and the existing `stripQuoteMargin()` already removes cost/margin from what those roles and the customer see.

| Who | Sees the final (boosted) total? | Sees the "Ella premium +15%" line? |
|---|---|---|
| Founder (`margin:view`) | yes | **yes** |
| Ops / finance | yes — they must quote it | **no** |
| Customer | yes | no |

So the boost line item is **tagged margin-gated**: `stripQuoteMargin()` drops it for non-founders, and the customer message never carries it. Ops still sees the higher *total* (they need the number to send the quote) — they just don't see that it's a zone premium, exactly as they already don't see cost or margin. Implementation is one line of policy on the boost line item, no new plumbing.

## 4. Data model

```sql
-- migration 0020 (next free number after 0019_quote_soft_delete)
CREATE TABLE pricing_zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_name text NOT NULL,               -- match key: a KNOWN_PLACES town, e.g. "Ella" (D3)
  boost_pct  integer NOT NULL,            -- whole percent, e.g. 15 = +15%
  active     boolean NOT NULL DEFAULT true,
  -- optional geo fallback (D3): used only when set, for a GPS spot near the town that
  -- Google labels as a neighbouring village. Name match is primary.
  lat        double precision,
  lng        double precision,
  radius_km  double precision,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

`boost_pct` as a whole integer keeps the money math in integer cents (mirrors `markupPct`). Validation: `place_name` non-empty (ideally chosen from `KNOWN_PLACES`), `boost_pct` in a sane range (say 0–100), and `radius_km` > 0 **when** lat/lng are set (the geo columns are all-or-nothing).

## 5. Engine integration (exact hook points)

1. `rateCard.ts` — add `HotZone` type + optional `hotZones` on `RateCard`; `RATE_CARD` literal keeps none (zones are DB-only).
2. New `api/src/quote/hotZones.ts` — a pure `zoneBoostFor(endpoint, zones): number` (returns the max applicable multiplier, or 1). **Name-first** (D3): compare the endpoint's resolved name to each active zone's `place_name` (case-insensitive; exact for a known place, word-boundary contains for a free-typed display string), then the optional coords-in-radius fallback. Unit-tested in isolation (name match, radius fallback, D7 max-not-sum, inactive skipped).
3. `private.ts::legPriceCents` / `quotePrivateLegs` — apply `zoneBoostFor(leg.from/to)` to `rate` before `max(floor, …)`. The leg already carries `from`/`to` as **names**, which is the primary match key; coords are only consulted for the optional radius fallback (see D3).
4. `chauffeur.ts` — apply the same per-leg/per-day boost to its `billableKm × perKm` component (so chauffeur trips don't escape the boost — the Explore review flagged this as the easy-to-miss path).
5. `engine.ts` — no structural change; it already passes `rateCard` through. `finishPrice()` still runs once, last. The zone-premium **line item is tagged margin-gated** so `stripQuoteMargin()` hides it from non-founders and the customer (D9).
6. **Zone loading:** a `zonesRepo` (Postgres + in-memory, mirroring `quoteRepo`) exposes `activeZones()`; the request assembles `{ ...RATE_CARD, hotZones: await zonesRepo.activeZones() }` for a *live* price, and reads `hotZones` straight from the snapshot for a *locked* one.

## 6. Website / codegen integration

- `tools/generate-pricing.mjs` already prices routes off the rate card. It must load `activeZones()` (same repo) and pass them into the engine so generated `routes-data.js` / `transfers-data.js` / `trip/*` bake in the boosted price for any route whose endpoint is in a zone. Name-first matching (D3) is *especially* clean here: every website route runs between named `KNOWN_PLACES`, so the match is exact and stable — no coordinate lookups needed for the generated pages.
- **Codegen is now data-dependent** (it reads the DB), which is a change from today's pure-from-constants generation. Decide: run `npm run generate` on a schedule / on zone edit, or accept that the website reflects a zone change only on the next generate+deploy. Flag for owner. (The ops tool is always live; the website lags by a regenerate — probably fine, but should be a conscious choice.)
- Update `web-tests/unit/*-price-parity.test.js` to assert parity *with zones applied*, so a hand-edit still fails but the boosted numbers are the expected ones.

## 7. Founder admin (API + UI)

- `GET /admin/quote/zones`, `POST/PATCH/DELETE /admin/quote/zones/:id` — all `quote:approve`-gated (founder only), CSRF-protected like the other quote mutations.
- UI: a "Hot zones" panel inside the existing founder Rate Settings modal (`renderRateCardBody()`). Per D3 the primary control is dead simple: **pick a town** (from the same `KNOWN_PLACES` list the tool autocompletes from) and set a **boost %**, with an active toggle. The optional geo-fallback (lat/lng + radius) is an "advanced" affordance, not the default path — most zones are just a town + a percentage.

## 8. Rollout (phased, each independently shippable & reversible)

1. **Data + engine, dormant.** Migration 0020, `zonesRepo`, `hotZones.ts`, wire into `private.ts`/`chauffeur.ts`. With zero active zones, **every price is byte-identical to today** (regression-safe). Ship behind an empty table.
2. **Founder admin.** The CRUD API + Rate Settings panel. Now the founder can create a zone; ops prices react live.
3. **Website codegen.** Teach `generate-pricing.mjs` to read zones; update parity tests; regenerate.
4. **Founder-only polish.** Tag the boost line item margin-gated and label it (e.g. "Ella premium +15%") in the founder's margin view; `stripQuoteMargin()` already hides it from ops/finance and the customer (D9). No customer-facing display.

## 9. Test plan

- `hotZones.test.ts` — name match (exact known-place + word-boundary free-typed), optional radius fallback, inactive skipped, D7 (max not sum), no-zone = ×1.
- `private.test.ts` / `chauffeur.test.ts` — a leg in a zone is boosted; floor still wins when it should; **zero active zones ⇒ prices unchanged** (the regression guard for Phase 1).
- Rate-lock test — a quote locked with a zone keeps its boosted price after the zone's `boost_pct` is later changed (C2).
- Margin-gating test (D9) — the founder sees the premium line; the ops/finance and customer views (`stripQuoteMargin()`) do not, while the boosted total is unchanged for all.
- Route/RBAC test — non-founder gets 403 on the zones CRUD.
- Parity test — website generated prices match the engine *with zones applied*.

## 10. Self-critique / risks

- **R1 — codegen becomes stateful.** Today the website price is a pure function of constants; after this it depends on DB rows. A zone edit silently changes what the *next* `npm run generate` emits. Mitigation: log which routes a zone affected on generate; make regenerate part of the "save zone" founder flow, or document the lag explicitly (§6).
- **R2 — matching precision.** Name-first trusts the label our resolver returns. A known-place endpoint matches exactly; a free-typed endpoint is matched on its display string (word-boundary, so "Ella" ≠ "Bella…"), which can *miss* when Google returns a venue name instead of the town. Mitigation: word-boundary matching, the optional radius fallback (D3) for exactly those spots, and the founder-visible boost line (D9) so a missed/wrong boost is caught at approval.
- **R3 — silent margin/price movement.** A founder fat-fingers `boost_pct: 150` and every Ella trip triples. Mitigation: validate range (0–100), and consider a confirm on large values. The founder sees the premium as an explicit line (D9) at approval, so a bad zone is visible before anything is sent.
- **R4 — rate-lock leakage (the subtle one).** If zones were read live at *approval* instead of from the snapshot, an approved quote could re-price. The whole point of D5/C2 is to fold zones into `rate_card_json`; the test in §9 is the guard. This is the mistake most likely to ship unnoticed — call it out in review.
- **R5 — chauffeur path missed.** Easy to boost `private.ts` and forget `chauffeur.ts`, letting chauffeur trips dodge the premium. §5.4 + the chauffeur test exist precisely to prevent this.
- **R6 — scope creep on "all rates."** Owner said "all rates"; D8 excludes shared corridors. If that's wrong, shared needs its own mechanism — confirm before building.

## 11. Out of scope (v1)
Pass-through detection (D2), shared-corridor boosts (D8), a structured-geocode locality lookup (we use name-match against `KNOWN_PLACES` instead — D3), a map-pick UI for the optional zone radius, and time-windowed zones (e.g. "boost during the festival only").

## 12. Open questions for the owner

**Decided 2026-07-22 (this doc):** matching = **name-first** against `KNOWN_PLACES`, geo-radius optional fallback (D3); premium visibility = **founder-only** via the existing `margin:view` gate — hidden from ops *and* the customer (D9).

Still open:
1. Endpoint-only, or should a route *passing through* a zone also be boosted? (D2 — recommend endpoint-only.)
2. Shared rides in or out? (D8 — recommend out.)
3. Website: accept "updates on next regenerate/deploy", or wire regenerate into the founder save? (§6/R1.)
4. Any cap on `boost_pct`? (R3 — recommend 0–100 with a confirm above, say, 50.)
