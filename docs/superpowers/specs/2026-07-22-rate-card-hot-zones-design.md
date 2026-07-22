# Rate-card hot zones — design (DRAFT for owner review)

**Status:** proposal only. No code written. Owner asked (2026-07-22) to *design, critique, and commit a plan* for later review.
**Revision 3 (2026-07-22)** — after a full code-verified critique. Major corrections: §2/§6 now describe the website integration **honestly** (the codegen exports constants and the front-end recomputes prices — it never calls the engine); a new constraint **C3** covers the web checkout drift guard (the page↔checkout mismatch class fixed once before in PR #43); **D1/D9 reconciled** (the boost lives *inside* the leg amount — there is no separate premium line); **D3** gains a concrete matching spec with Sri-Lanka-specific edge cases; **D10** adds the missing chauffeur design (chauffeur pricing is aggregate, not per-leg); **D11** decides the custom-rate interplay; phases re-cut in §8 so the website can never disagree with the server. Earlier revisions: D2 any-touch (no pickup/drop-off distinction), D3 name-first, D9 founder-only.
**Guardrail:** this touches pricing. Per CLAUDE.md ("STOP and ask before touching pricing"), nothing here ships without an explicit owner go on this doc.

## 1. Goal (owner, 2026-07-22)

> "Create a hot zone for the rate card. If a certain list of cities/towns are searched and we calculate rates, boost the rate by X%. Founder-editable, and it applies to **all** rates generated in ops **and** the website."

A *hot zone* is a premium area (e.g. a resort town, a festival hotspot, a hard-to-service region). When a trip touches one, its price goes up by a founder-set percentage. The list of zones and their percentages are the founder's to change, and the change must flow through **both** pricing surfaces: the ops quote tool and the website.

## 2. Where prices are computed today (the surfaces a boost must reach)

Backend is the single source of truth for pricing ([[ceylon-hop-pricing-source-of-truth]]) — but "source of truth" does **not** mean every surface calls the engine. Verified against the code:

| Surface | How it prices | Files |
|---|---|---|
| Ops quote tool | live engine call per estimate/save | `internalQuote.ts` → `engine.ts` |
| Private legs (engine) | `max(floor, billableKm × perKmCents)` per leg | `private.ts:16` (`legPriceCents` / `quotePrivateLegs`) |
| Chauffeur (engine) | day rate × days + **ONE aggregate** distance charge (`Σ buffered travel km + idle-min km`) × perKm | `chauffeur.ts` — **not per-leg** (see D10) |
| Shared (engine) | fixed per-seat corridor price — not per-km | `shared.ts`, `departureRepo.ts` |
| Final rounding | `finishPrice()` once, after the core calc | `engine.ts` |
| **Website route pages / booking UI** | **front-end JS recomputes prices** from constants (`PER_KM`, `FLOORS`, `BUFFER_PCT`…) that `tools/generate-pricing.mjs` dumps from the backend (`dump:pricing`) into fenced blocks in `transfers-data.js` / `routes-data.js`. **The codegen never calls the engine.** | `tools/generate-pricing.mjs`, `booking.js`, parity-guarded by `web-tests/unit/*-price-parity.test.js` |
| **Website checkout** | front-end computes `quotedTotal` client-side (`booking.js:1514`) and submits it; the **server re-prices with the engine and applies a drift guard** (`bookings.ts:25`) that flags/limits divergence | `bookings.ts` |

Three hard constraints:

- **C1 — one formula, two implementations.** The engine and the front-end mirror compute the same formula from the same dumped constants, held together by parity tests. A zone boost therefore must be implemented **twice**: in the engine, and in the front-end mirror (with the zone list dumped alongside the other constants). There is no shortcut where the website "calls the engine" — it doesn't.
- **C2 — rate-lock.** An approved quote is priced against a *locked snapshot* of the rate card ([[ceylon-hop-rate-lock]]). Zones must live **inside** the `RateCard` snapshot so a locked quote keeps the zones it was priced with; a later zone edit must never re-price an approved quote. (Bonus, verified: `stripQuoteMargin()` already deletes `rateCardJson` for non-founder roles, so the zone list inside a locked snapshot is hidden from ops for free.)
- **C3 — checkout drift guard.** If the server boosts a route the front-end doesn't know is boosted, **every zone-touching web booking becomes a page-says-$121 / server-says-$139 mismatch** and trips the `quotedTotal` drift guard. This exact page↔checkout mismatch class was a real production bug fixed by the psychological-pricing work (PR #43). Consequence: **server-side zone pricing for web-reachable paths and the front-end zone mirror must ship in the same release** — the rollout in §8 is cut around this.

## 3. Design decisions

### D1 — What does "boost the rate" mean? → per-leg multiplier folded INTO the leg amount (no separate line)
The boost multiplies the per-km rate for a zone-touching leg: `rate → rate × (1 + boost)`, then `max(floor, km × boostedRate)` as today. The premium therefore lives **inside the leg's own line-item amount** — there is **no separate "premium" line item**. This matters for D9: line items are visible to every role and are what the money-pane build-up and the customer message are assembled from; a hidden separate line would make ops see lines that don't sum to the total. Folding it in keeps every role's arithmetic consistent; the founder-only *annotation* (D9) is metadata, not a line.

### D2 — Which part of the leg counts? → any touch; no pickup/drop-off distinction
**Decided (owner):** if a leg touches a hot town at either end, elevate the price — start and end are treated identically. The premium is the cost of *servicing the area*, which is direction-neutral (no loophole where "Ella → Colombo" dodges what "Colombo → Ella" pays).
**Still open — drive-throughs** (leg passes through a zone without starting/ending there): recommend **out of v1** — endpoints use data we already have; drive-through needs the route polyline, which manual-distance legs don't carry. See §12 Q1.

### D3 — How is a location matched to a zone? → name-first (known-places), with an explicit matching spec
**Decided (owner):** match on the **town name**, not a pin+radius. A zone *is* a `KNOWN_PLACES` town the founder picks from the same list the tool autocompletes from. Zero new Google calls.

The phrase "word-boundary contains" is not enough — the matching rules must be explicit, because Sri Lankan names collide:

**Matching algorithm (in order):**
1. Normalize both sides: trim, lowercase (the existing `norm()` in `maps.ts`).
2. **Exact match** — endpoint name equals `place_name` → match.
3. **Compound known-place split** — `KNOWN_PLACES` has compound entries (`'Sigiriya / Dambulla'`, `'Colombo Airport (CMB)'`). Split `place_name` on `/` and strip parentheticals; an endpoint exactly matching any part (`'sigiriya'`, `'dambulla'`) → match.
4. **Free-typed fallback** — for an endpoint that is NOT a known place (a Google display string like `"Nine Arch Bridge, Ella, Sri Lanka"`): match if the zone's town appears as a **comma-delimited address component** of the string — not a bare substring, not merely word-boundary. `"…, Ella, Sri Lanka"` → the component `"Ella"` matches zone *Ella*. `"Galle Face Green, Colombo"` → components are `"Galle Face Green"` and `"Colombo"`; **no component equals "Galle"**, so a *Galle* zone does NOT match (Galle Face is in Colombo, 120 km away — word-boundary "contains" would have false-positived here).
5. **Optional geo fallback** — a zone may carry `{ lat, lng, radiusKm }`; an endpoint with resolved coordinates inside that haversine circle also matches. For the one case names miss: a GPS pickup near a hot town that Google labels as a neighbouring village.

**Worked examples (these become `hotZones.test.ts` cases):**

| Zone | Endpoint | Match? | Why |
|---|---|---|---|
| Ella | `Ella` | ✅ | exact |
| Ella | `Nine Arch Bridge, Ella, Sri Lanka` | ✅ | address component |
| Ella | `Bella Vista Hotel, Colombo` | ❌ | no component equals "Ella" |
| Galle | `Galle Face Green, Colombo` | ❌ | component is "Galle Face Green", not "Galle" |
| Galle | `Galle Fort, Galle` | ✅ | address component |
| Sigiriya / Dambulla | `Dambulla` | ✅ | compound split |
| Colombo City | `Colombo Airport (CMB)` | ❌ | airport ≠ city; no shared component |

Caveat (R2): a free-typed *venue* whose display string omits the town (Google returns just the establishment) is missed by names — that's what the optional radius is for.

### D4 — Where do zones live + who edits them? → `pricing_zones` table + founder admin, with audit + kill switch
Founder-editable ⇒ database. No founder rate-card admin exists today (documented deferred item); this is its first slice: a self-contained CRUD gated by `quote:approve` (founder-only), surfaced in the Rate Settings modal. Notes:
- **Audit:** zone edits are pricing changes — every row carries `created_by` / `updated_by` (staff email, same pattern quotes gained in migration 0015). No silent % changes.
- **Kill switch:** env var `HOT_ZONES_DISABLED=1` makes `activeZones()` return `[]` — one flip turns a fat-fingered zone incident into a non-event without touching data.
- **Cap note:** the panel is visible under `margin:view`, edits gated by `quote:approve`. Today both = founder exactly; the doc records the assumption in case roles ever diverge.

### D5 — How do zones reach the engine + the snapshot? → fold into the `RateCard` object
Optional `hotZones?: HotZone[]` on the `RateCard` type. Live pricing composes `{ ...RATE_CARD, hotZones: await zonesRepo.activeZones() }`; a **locked** quote reads `hotZones` from its `rate_card_json` snapshot (satisfies C2 automatically — the snapshot already round-trips the whole card; same optional-field back-compat precedent as `priceFinishing?`). Legacy snapshots without `hotZones` = no boost, exactly today's behaviour.

### D6 — Floor & finishing → boost the rate, floor still protects, finish runs last; margin model is an OWNER CALL
`legPriceCents` becomes `max(floor, round(km × rate × (1 + boost)))`. A short leg still under the floor after boosting pays the floor (the boost had no room). `finishPrice()` runs once, last, unchanged. Expectation-setting: **a zone does nothing to floor-priced short hops** — a +15% Ella zone leaves a $29-floor 10 km hop at $29.

**Open (new, §12 Q5): is the boost margin or cost?** Mechanically the simplest build treats the boost as pure margin (cost side untouched → `marginEstimateCents` rises by the full boost). But this doc's own motivation includes "hard-to-service region" — i.e. genuinely higher *cost* (deadhead, mountain roads). Booking it all as margin **overstates margin on zone trips in the founder's own margin view**. Options: (a) pure margin (simple, overstated); (b) split — also scale the leg's cost basis by some fraction of the boost (honest, more plumbing). Recommend (a) for v1 *with eyes open*, owner to confirm.

### D7 — Stacking → at most one boost per leg (the max applicable)
Both ends in zones, or overlapping zones → apply a **single** boost = the largest applicable `boost_pct`, never the sum.

### D8 — Shared corridors → out of scope for v1
Shared is a fixed per-seat corridor price; a per-km multiplier doesn't map onto it. v1 = private + chauffeur. If the owner wants shared boosted, that's a per-corridor multiplier — its own decision (§12 Q2).

### D9 — Visibility → founder-only; implemented as gated METADATA, not a hidden line
**Decided (owner):** the premium is visible to the founder only — not ops/finance, not the customer.

| Who | Sees the final (boosted) total? | Sees "Ella premium +15%"? |
|---|---|---|
| Founder (`margin:view`) | yes | **yes** |
| Ops / finance | yes — they must quote it | **no** |
| Customer | yes | no |

**Corrected implementation (verified against the code — this is NOT "no new plumbing"):** `shape()` currently passes `lineItems` *including `meta`* and `warnings` to **all** roles, and `stripQuoteMargin()` strips only `marginCents` / `rateCardJson` / `marginEstimateCents`. So:
- The boost is folded into the leg amount (D1) — nothing to hide in the amounts, sums stay consistent for everyone.
- The founder-only annotation (zone name + %) rides in the leg line's **`meta`** — and **both wire paths must be extended to strip zone meta for non-`margin:view` callers**: `shape()` (estimates) and `stripQuoteMargin()` (stored quotes). A leak-test is mandatory (§9).
- **Warnings must never mention zones** — `warnings` go to every role. No "hit the Ella premium" strings.
- The zone list inside a locked snapshot is already hidden (C2 bonus: `rateCardJson` is stripped for non-founders).
- **Known consequence (accepted by D9):** ops cannot explain a zone-driven price move. A draft re-priced after a zone edit just… changes, and support has no visible reason (R8). That is the price of founder-only invisibility; the owner should confirm they're comfortable with it.

### D10 — Chauffeur (NEW): per-day restructure, because today's charge is aggregate
`quoteChauffeur()` computes **one** distance charge over `Σ buffered travel km + idle-day minimum km`. There is no per-leg rate to multiply — §5's "hook" requires restructuring the distance charge into a **per-day sum**:
- **Travel day:** `buffered(day.km) × perKm × (1 + boostForDay)`, where `boostForDay = zoneBoostFor(day.from) ∨ zoneBoostFor(day.to)` (max, per D7). A day touching Ella is boosted; other days aren't.
- **Idle day:** an idle day has **no location in the data at all** (idle days are the *absence* of a travel leg). Rule: an idle day inherits the location of the **previous travel day's `to`** (where the vehicle is parked). Idle-min km for a day parked in Ella are boosted; parked in Colombo, not.
- **Day rate:** **not boosted** (recommendation). The premium models distance/servicing cost, and the day rate is the driver's flat fee. If the owner wants premium day rates in hot towns, that's a deliberate extension, not a default.
- The line-item labels keep their current shape (one aggregate "Distance — N km" line is fine to *display*); only the internal computation becomes per-day. Total = Σ per-day charges, so the invariant sum(lines)=total holds.

### D11 — Custom per-km rates (GL-1d, NEW): zones do NOT apply to operator-priced tiers
Van14/custom take an operator-supplied per-km rate; the engine also imputes cost from it (`override / 1.15`). Recommendation: **a custom rate is authoritative — no zone boost on top.** Rationale: the operator hand-prices these trips end-to-end (with founder review at approval); silently inflating a hand-typed rate — invisibly, per D9 — would make the operator's own number wrong in ways they can't see or explain. The founder sees margin at approval and can adjust the custom rate directly. (Consequence, stated honestly: a van14/custom Ella trip escapes the automatic premium; the founder applies it by hand via the custom rate. Owner may veto in review.)

## 4. Data model

```sql
-- migration number: NEXT FREE at build time — 0020 today, but multi-stop rides and
-- discounts (M18) are pending builds in other worktrees; whoever lands first takes it.
CREATE TABLE pricing_zones (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  place_name text NOT NULL,               -- match key: a KNOWN_PLACES town, e.g. "Ella" (D3)
  boost_pct  integer NOT NULL,            -- whole percent, e.g. 15 = +15%
  active     boolean NOT NULL DEFAULT true,
  -- optional geo fallback (D3 step 5): all-or-nothing trio
  lat        double precision,
  lng        double precision,
  radius_km  double precision,
  -- audit (D4): pricing changes are never anonymous
  created_by text,
  updated_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
```

Validation: `place_name` non-empty (chosen from `KNOWN_PLACES` in the UI); `boost_pct` 0–100 with a UI confirm above 50 (§12 Q4); `radius_km > 0` when lat/lng set (trio all-or-nothing).

## 5. Engine integration (exact hook points, corrected)

1. `rateCard.ts` — `HotZone` type + optional `hotZones` on `RateCard`; the `RATE_CARD` literal carries none (zones are DB-only).
2. New `api/src/quote/hotZones.ts` — pure `zoneBoostFor(endpointName, coords, zones): number` implementing the D3 algorithm (returns the max applicable multiplier, or 1). Unit-tested against the D3 worked-examples table + D7 + inactive-skipped + kill switch.
3. `private.ts` — **hook is `quotePrivateLegs`, not `legPriceCents` as-is**: `legPriceCents(distanceKm, vehicle, override?, card?)` doesn't receive the leg's names — either extend its signature with an optional `boost` or apply the boosted rate in `quotePrivateLegs`' loop. **The floor-warning comparison (`Math.round(bKm × rate) < floor`) must use the boosted rate**, or "hit the minimum" warnings misfire on boosted legs.
4. `chauffeur.ts` — per-day restructure per **D10** (travel-day boost by that day's endpoints; idle days inherit the previous `to`; day rate unboosted).
5. `engine.ts` — no structural change; `finishPrice()` still runs once, last. Zone annotation goes into leg-item `meta` only (D9); **never** into `warnings`.
6. **Wire gating (new plumbing, per D9):** extend `shape()` and `stripQuoteMargin()` to strip zone `meta` for non-`margin:view` callers.
7. **Zone loading:** `zonesRepo` (Postgres + in-memory, mirroring `quoteRepo`) exposes `activeZones()` (returns `[]` when `HOT_ZONES_DISABLED=1`). Live pricing composes the card at the call site; locked quotes read `hotZones` from the snapshot. **v1-ops wiring:** only `internalQuote.ts` composes zones (Phase 2); `bookings.ts` joins in Phase 3 together with the front-end mirror (C3).
8. `engine.ts` custom-rate path — per **D11**, when `customPerKmCents` is set, skip the boost.

## 6. Website integration (rewritten — the codegen does NOT call the engine)

The website recomputes prices in front-end JS from constants dumped by `dump:pricing` → `generate-pricing.mjs`. Therefore:

- **Zones ship as another dumped constant.** `dump:pricing` adds `HOT_ZONES` (active zones only: `place_name`, `boost_pct`, optional geo) to the payload; `generate-pricing.mjs` injects it into the fenced block like `PER_KM` et al. The committed generated files therefore carry a **zones snapshot** — which is also what makes CI parity testable (below).
- **The front-end mirror implements the matching + boost a second time** (C1): the same D3 name rules + D7 max + D6 floor interaction, in `booking.js`'s price computation. This is unavoidable double-implementation — held together by parity tests, exactly like the rest of the mirror.
- **`bookings.ts` (server re-price for web checkout) starts composing zones in the same release** — never before the mirror ships (C3), or every zone booking trips the drift guard.
- **CI/parity story:** CI has no prod DB. Parity tests assert **internal consistency against the committed `HOT_ZONES` snapshot** (generated files ↔ engine fed that same snapshot), not DB freshness. Freshness is the regenerate cadence (§12 Q3): a founder zone edit changes ops prices immediately and website prices on the next `npm run generate` + deploy — until then the *page* shows the old price and `bookings.ts` must price with the **snapshot the page was built from**… which it can't know. Practical resolution: keep the drift-guard tolerance ≥ the max active boost, OR regenerate+deploy promptly after zone edits (Q3). This tension is inherent to a generated site; the owner picks the cadence.
- Update `web-tests/unit/*-price-parity.test.js` to cover boosted routes.

## 7. Founder admin (API + UI)

- `GET/POST/PATCH/DELETE /admin/quote/zones[/:id]` — `quote:approve`-gated, CSRF-protected, stamping `created_by`/`updated_by` from the session identity.
- UI: a "Hot zones" panel in the Rate Settings modal — pick a town (from `KNOWN_PLACES`), set a boost %, active toggle; the geo trio is an "advanced" affordance. Mockup: `hotzones-mockup.html` (2026-07-22).
- A visible "all zones paused" banner when `HOT_ZONES_DISABLED` is set, so the kill switch is never silently on.

## 8. Rollout (re-cut so the website can never disagree with the server — C3)

1. **Dormant plumbing.** Migration, `zonesRepo`, `hotZones.ts`, engine wiring (private per D1/D3, chauffeur per D10, custom-rate skip per D11), wire-gating in `shape()`/`stripQuoteMargin()`. Zero active zones ⇒ **every price byte-identical to today**. `bookings.ts` untouched.
2. **Founder admin, ops-only effect.** CRUD + panel. Activating a zone boosts **ops quotes only** (`internalQuote.ts` composes zones; `bookings.ts` still doesn't). Stated honestly: during this phase a zone-touching route is quoted higher in ops than the website sells it — acceptable because ops quotes are bespoke, but the owner should know.
3. **Website, as ONE unit.** `dump:pricing` `HOT_ZONES` + front-end mirror matching + `bookings.ts` composing zones + parity tests — shipped together, never piecemeal (C3).
4. **Polish.** Founder-only meta label ("Ella premium +15%") rendering in the ops money pane's founder view; leak-tests hardened.

## 9. Test plan

- `hotZones.test.ts` — the **D3 worked-examples table verbatim** (Galle/Galle Face, compound split, address-component fallback), radius fallback, D7 max-not-sum, inactive skipped, `HOT_ZONES_DISABLED` ⇒ `[]`.
- `private.test.ts` — boosted leg; floor still wins; **floor-warning uses the boosted rate**; zero active zones ⇒ unchanged (Phase-1 regression guard).
- `chauffeur.test.ts` — D10: only the zone-touching day boosted; idle-day inherits previous `to` (boosted when parked in a zone); day rate unboosted; totals = Σ per-day.
- Engine — D11: custom-rate quote ignores zones.
- Rate-lock — a quote locked with a zone keeps its price after the zone's % changes (C2).
- **Leak tests (D9)** — non-`margin:view` estimate + stored-quote responses contain **no** zone meta, no zone warnings; founder responses do; totals identical for all roles.
- RBAC — non-founder 403 on zones CRUD.
- Parity — generated files ↔ engine **fed the committed `HOT_ZONES` snapshot** (§6), boosted routes included.
- Drift — web checkout on a boosted route with the mirror shipped: `quotedTotal` within guard tolerance.

## 10. Self-critique / risks

- **R1 — page↔checkout mismatch (repo precedent: PR #43).** The sharpest risk, now a hard constraint (C3) + phase cut (§8.3). Residual: the regenerate lag between a zone edit and the next deploy (§6, §12 Q3).
- **R2 — matching precision.** Name rules are now a spec with tests (D3); residual miss = venue strings that omit the town → optional radius fallback; a wrong/missed boost is visible to the founder at approval (D9).
- **R3 — fat-finger.** 0–100 validation, UI confirm >50, kill switch (D4), founder-visible premium at approval.
- **R4 — rate-lock leakage.** Zones fold into `rate_card_json` (D5/C2) — guarded by the §9 lock test. Still the likeliest silent mistake; call it out in code review.
- **R5 — chauffeur drift.** D10 restructures the aggregate charge; the per-day tests are the guard against a rewrite regressing existing chauffeur totals (zero-zone case must be byte-identical).
- **R6 — "all rates" scope.** D8 excludes shared; D11 excludes custom-rate tiers. Both are explicit owner-reviewable exclusions now, not accidents.
- **R7 — double-implementation drift.** The front-end mirror reimplements matching+boost (C1); parity tests against the committed snapshot are the only guard. Any future D3 rule change must touch both implementations.
- **R8 — invisible price moves for ops.** A draft re-priced after a zone edit changes with no reason ops can see (D9 consequence, accepted). Support cannot answer "why did my draft change?" — the founder can.

## 11. Out of scope (v1)
Drive-through detection (D2), shared-corridor boosts (D8), zone boosts on custom-rate tiers (D11), structured-geocode locality lookup, map-pick UI for the geo trio, time-windowed zones, premium day rates (D10).

## 12. Open questions for the owner

**Decided so far:** any-touch, direction-neutral (D2) · name-first matching w/ spec table (D3) · founder-only via gated meta (D9) · boost folded into leg amount, no separate line (D1) · chauffeur per-day w/ idle-inherit, day rate unboosted (D10, recommendation) · custom rates exempt (D11, recommendation).

Still open:
1. **Drive-throughs** — boost a leg that only passes through a zone? (Recommend out for v1.)
2. **Shared rides** — in or out? (Recommend out.)
3. **Website cadence** — accept "website updates on next regenerate/deploy" (with drift-guard tolerance ≥ max boost in the interim), or wire regenerate into the founder's zone save? (§6.)
4. **Boost cap** — 0–100 with a confirm above 50? (R3.)
5. **Margin or cost?** — book the boost as pure margin (simple, overstates margin on zone trips) or split part into the cost basis? (D6 — recommend pure margin for v1, eyes open.)
