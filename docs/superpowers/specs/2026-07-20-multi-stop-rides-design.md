# Multi-stop rides — leg model redesign

**Date:** 2026-07-20
**Status:** Draft v3 — post-audit, awaiting final owner review.
**Owner decisions folded in (2026-07-20):** ops-tool-only rollout (website gets a
signpost, not the feature) · buffer and floor apply **per day**, not per segment ·
a wait-time calculator for pricing stops comes later.
**v3:** findings from a full backend + ops-UI + website code audit folded in
(notably: `breakdown.ts` added to Phase 1; warning-string compatibility; ops-UI
per-segment state rework scoped; `/bookings/trip` pin test).
**Scope:** quote engine, ops quote tool, one line of website copy.

## 1. Context and problem

A real inbound itinerary (received 2026-07-20) exposed two shapes our leg model cannot
express:

| Date | Requested route | Their price |
|---|---|---|
| 16 Aug | Colombo Airport → Ella | $89 |
| 17 Aug | Nanu Oya → Kandy | $54 |
| 19 Aug | Kandy → Dambulla Cave Temple → Habarana | $49 |
| 21 Aug | Habarana → Polonnaruwa → Habarana | $49 |
| 22 Aug | Habarana → Anuradhapura → Thanthirimale → Anuradhapura | $69 |
| 23 Aug | Anuradhapura → Nilaveli Beach | $54 |
| 25 Aug | Nilaveli Beach → Negombo | $109 |

What it demonstrates:

1. **En-route stops** (19 Aug): a stop between origin and destination. Today this must be
   faked as two legs, which double-charges the per-leg floor (see §4).
2. **Out-and-back** (21 Aug): a day that ends where it started. Today ops fakes it via
   duplicate-leg-and-swap.
3. **Hybrids** (22 Aug): relocation plus side-trip in one day. Not expressible at all.
4. **Broken chains** (17 Aug): the customer rides the Ella→Nanu Oya train themselves; we
   pick up at Nanu Oya. The ops tool already tolerates this (legs are independent); the
   customer web trip flow cannot (it derives legs from one flat stop list) — out of scope
   here, see §6 Phase 3b.
5. **Independent days with gaps** (18/20/24 Aug): per-day hires, no vehicle retention.

Additional requirements from how customers actually engage:

- Most customers think **point-to-point**; fewer think chauffeur; fewer still send
  detailed multi-stop plans. The simple case must stay exactly as simple as today.
- Dates are often soft or absent. The plan's backbone must be sequence, not calendar.
- Customers frequently ask for **both** the point-to-point total and the chauffeur rate
  for the same itinerary. One structure must feed both pricers.

## 2. Decision: the ride model

> **A ride is one day's journey: an ordered list of 2+ stops.**
> A leg (`from → to`) is the degenerate case: a ride with exactly 2 stops.

- Simple transfer: `[Airport, Ella]` — unchanged experience for the majority.
- En-route stop: `[Kandy, Dambulla, Habarana]`.
- Out-and-back: `[Habarana, Polonnaruwa, Habarana]` — last stop equals the first (UI
  offers an "and return" affordance; the data model is just the stop list).
- Hybrid: `[Habarana, Anuradhapura, Thanthirimale, Anuradhapura]` — no special handling.
- Rides do **not** have to chain: ride N may start somewhere other than where ride N−1
  ended (train gaps, rest days). Never an error.

**Pricing principle (owner decision 2026-07-20):** a ride is priced as **one day's
drive** — sum the segment distances, apply the km buffer **once to the day's total**, and
apply **one floor per ride**. This replaces the N-floors-per-day effect of faking a
multi-stop day as separate legs. (Note: "per day" is realized as **per ride** — a ride
models one day's journey. If ops enters two rides on the same date, each is its own hire
with its own floor, exactly as two same-day legs are today.)

**Availability (owner decision 2026-07-20):** multi-stop rides are an **ops-tool-only**
capability for now. Customers cannot build them on the website; the website gets a short
"reach out for more complex routes" signpost (§6 Phase 3a). This keeps the stop-premium
question (driver waiting time) inside ops discretion — ops sees the price and adds the
existing waiting/sightseeing fee flags manually until the wait-time calculator exists
(§9.1).

### Rejected alternatives

- **Stays-as-backbone** (ordered stays + rides attached): right ingredients, wrong
  emphasis — the majority think in rides, not stays. Nights/stays return as an *optional*
  layer for dateless chauffeur quoting (parked, §9).
- **`roundTrip` flag + `via[]` waypoints on legs:** papers over the mismatch; still can't
  express hybrids cleanly, and operators would still be editing a workaround.
- **Buffer per segment** (spec v1): rejected by owner in favor of per-day buffer — the
  buffer models one day's positioning slack, not per-hop slack, and per-day keeps the
  2-stop case arithmetically identical to today.

### Naming

The wire field stays **`legs`** (back-compat; every consumer keeps working). The new
engine type is named **`Ride`**. Ops-UI copy may keep saying "Leg" for now — renaming copy
is optional polish, not part of this change.

## 3. Data shapes

### Engine types (`api/src/quote/types.ts`)

```ts
// New canonical shapes (stops.length >= 2, segmentKms.length === stops.length - 1)
export interface Ride { stops: string[]; segmentKms: number[] }
export interface ChauffeurRideDay extends Ride { date: string }

// Legacy shapes remain accepted on the wire:
export interface PrivateLeg { from: string; to: string; distanceKm: number }
export interface ChauffeurTravelDay { date: string; from: string; to: string; distanceKm: number }
```

`QuoteRequest` accepts `legs: (PrivateLeg | Ride)[]` and
`travelDays: (ChauffeurTravelDay | ChauffeurRideDay)[]`.

Parallel arrays (`stops` + `segmentKms`) are chosen over `segments: [{from,to,km}]`
deliberately: no duplicated place names to drift apart, and the only invariant (lengths)
is trivially validated. The DB stores nothing new (§6 DB), so the schema.ts
parallel-array apology does not apply here — this is a wire/engine shape, not a table.

### Normalization — one place, at the engine entry

`quote()` normalizes every element before pricing; the pricers only ever see `Ride`:

```ts
{ from, to, distanceKm }  →  { stops: [from, to], segmentKms: [distanceKm] }
```

This single rule is what makes the change safe: every stored quote in `quotes.requestJson`
(reprice, rate-lock, founder reopen) and every current caller keeps working bit-for-bit.
Rate-lock is unaffected — it snapshots the rate card, not request shapes, and the locked
card is passed into `quote()` exactly as today. The old shape also acts as a de facto
feature flag: nothing about existing traffic changes until a caller actually sends a
3+-stop ride.

### Validation rules

- `stops.length >= 2`; `segmentKms.length === stops.length - 1`.
- Consecutive stops must differ (no zero-length `A → A` segments). Non-consecutive
  repeats are the whole point (out-and-back).
- Segment km follow the same numeric rules as leg km today (Zod `>= 0` at the ops schema;
  the $0-leg guard from the 2026-07 post-deploy review applies per segment).
- Ops schema caps stops at **8 per ride** (sanity bound for UI + Distance Matrix; the
  sample itinerary maxes at 4).

## 4. Pricing rules

### Private (`api/src/quote/private.ts`)

Per ride, with `buffer(km) = clamp(round(km × bufferPct/100), 5, 15)` unchanged:

```
rideRawKm      = Σ segmentKms
rideBillableKm = rideRawKm + buffer(rideRawKm)          // buffer ONCE per day
ridePriceCents = max( floorCents[vehicle], round(rideBillableKm × perKmCents[vehicle]) )
```

- **Buffer per day, floor per day** (owner decision 2026-07-20). A 2-stop ride is
  arithmetically identical to today's leg — one raw km value, one buffer, one floor — so
  backward compatibility is provable, not aspirational.
- `protectedMinimumCents` (engine.ts) becomes `rides.length × floorCents[vehicle]` —
  same formula, applied to rides.
- Cost basis (engine.ts): `rideBillableKm × costPerKm` per ride, summed — equivalent for
  2-stop rides. ⚠️ Caveat: cost is km-linear and blind to driver hours, so
  `marginEstimateCents` overstates margin on stop-heavy days (driver waits unpaid in the
  model). Acceptable until the wait-time calculator (§9.1); founders should read margins
  on multi-stop days with that in mind.
- Line-item label: `stops.join(' → ')` + vehicle — identical output for 2-stop rides.
  `meta` gains `stops` and `segmentKms`; keeps `distanceKm` (= segment sum) and
  `billableKm` so existing consumers of meta keep working. (The ops UI zips travel line
  items to legs positionally via `meta.billableKm`; one line item per ride preserves
  that count parity.)
- Floor-hit warning names the ride by joined stops — **with one exactness trap**: the
  current warning string is `` `${from}→${to} hit …` `` with NO spaces around the arrow,
  while the label uses spaces. For 2-stop rides the warning must keep the no-space form
  byte-for-byte (or Phase 0 goldens fail by design). Multi-stop warnings may use the
  spaced joined form — they have no golden to match.

### Chauffeur (`api/src/quote/chauffeur.ts`)

Only the per-day km accumulation changes: a travel day's buffered km becomes
`dayRawKm + buffer(dayRawKm)` over the day's segment sum — the same per-day rule as
private, and identical to today for old-shape input (one leg per day). Day count,
idle-day derivation (`days − travelDays.length`), idle min-km (not buffered, decision
I1-b), day rate, and the ≥2-distinct-dates chauffeur heuristic (`internalQuote.ts`) are
all unchanged. A multi-stop day is still one travel day.

Note for quoting itineraries like §1 as chauffeur: the travel-day list is not identical
to the customer's ride list — e.g. 17 Aug needs a `train_support` reposition day (car
drives to meet the train) even though the customer sits on the train. This is existing
ops practice, unchanged by this spec.

### Worked example (car: 40.25¢/km sell, $29 floor, 10% buffer clamped 5–15)

19 Aug, `Kandy → Dambulla (72 km) → Habarana (23 km)`:

| | Today (2 legs) | New (1 ride) |
|---|---|---|
| Kandy→Dambulla | 72+7=79 km → $31.80 | raw 72 |
| Dambulla→Habarana | 23+5=28 km → $11.27 → **floor $29.00** | raw 23 |
| Ride total | **$60.80** | 95+10=105 km × 40.25¢ = **$42.26** |

21 Aug out-and-back `Habarana → Polonnaruwa → Habarana` (~47 km each way): today
2 × floor-hit legs = **$58.00**; new = 94+9 = 103 km → **$41.46**.

### Pricing-change record (owner-approved 2026-07-20)

One-floor-per-day **lowers** short-hop multi-stop days versus quoting them as separate
legs (−$18.54 and −$16.54 above; market quoted $49 for both days). Approved with eyes
open, on the basis that: (a) this capability is ops-only, so every such price passes
through a human who sees it before it is sent; (b) the waiting/sightseeing/safari fee
flags remain the manual stop-premium lever; (c) a wait-time calculator (§9.1) will price
stop dwell properly later. If quoted totals look thin in practice, the lever is fees per
stop — never floor multiplication.

Two compounding effects to be aware of, both accepted: (a) `protectedMinimumCents` also
feeds `finishPrice` as the downward-rounding guard, so a collapsed multi-stop day both
loses N−1 floors *and* allows the nearest-50¢ finishing to round slightly lower; (b)
during the ops-only window, the **website trip flow still prices the same multi-stop day
as N floored pairwise legs** (`services/pricing.ts` `priceTrip`) — so a customer's
self-built web price and an ops re-quote for the identical day will disagree, web higher.
That divergence is the double-floor bug living out its deprecation, resolved at Phase 3b;
until then ops quotes are simply better, which is the correct direction for trust.

## 5. Distance and duration resolution

- `resolveLegKm` (ops route) generalizes to resolve **each consecutive pair** with one
  `maps.distance(from, to)` call per segment — same per-pair cost as today; a 4-stop ride
  makes 3 calls. Out-and-back resolves each direction separately (A→B and B→A may differ).
- The adapter already returns `{ km, durationMin }` per pair (maps.ts): the ride's
  drive time = Σ segment durations. The ops UI's per-leg `driveTimeHours` becomes this
  per-ride sum, and the **existing ≥6 h long-drive flag** (ops-ui.html) now reads that
  sum — no new threshold invented. Note `driveTimeHours` is never serialized today
  (recomputed on resolve, lost on save/reopen); that stays true — a reopened quote shows
  duration and the long-day flag only after a re-resolve, same as today.
- Known-place-by-coords rule and the >900 km geocode rejection apply per stop/segment
  unchanged. Stops use the same known-places autocomplete as today; bare-name geocoding
  remains the fallback with its existing risks. **Pre-check (Phase 2):** sanity-check the
  known-places catalog against the attraction-type stops customers actually request
  (Dambulla Cave Temple, Thanthirimale, beaches…) and top up obvious gaps — via-stops are
  POIs more often than towns.
- **Manual-distance is per-segment, and invalidation is structural:** any change to the
  stop list (edit, insert, delete, reorder) re-derives the segment array, preserving a
  segment's km/duration/manual state **only if its (from, to) pair is unchanged**;
  affected segments reset to auto-resolve. This generalizes the reopened-quote guard
  (manual km must not be clobbered until a location edit clears the flag) to segment
  granularity. On the wire, `segmentKms` entries are `number | null` — null means
  "resolve for me"; on reopen, non-null values are treated as manual per the existing
  guard. No separate manual flag travels on the wire.
- **Null vs the existing 0-means-unresolved convention:** today the wire sends
  `distanceKm: 0` for unresolved and reopen infers manual from `> 0`
  (`ops-ui.html` reopen; `internalQuote.ts` `<= 0` resolve guard). The rule carries over
  per segment: a resolved/manual segment serializes as its number (reopened as manual,
  exactly as today), an unresolved segment serializes as `null` (accepted alongside `0`
  for back-compat; both mean "resolve for me").

## 6. Component impact

### Quote engine (`api/src/quote/`) — Phase 1

- `types.ts`: add `Ride` / `ChauffeurRideDay`, widen `QuoteRequest`, add normalizer.
- `private.ts`: price rides per §4 (per-day buffer + floor).
- `chauffeur.ts`: per-day buffered sum per travel day.
- `engine.ts`: protected minimum per ride; cost per ride; labels via joined stops.
- **`breakdown.ts` (audit finding — previously missed):** `quoteBreakdown()` is a
  second raw-`QuoteRequest` consumer called *directly* by the ops `/estimate` route,
  bypassing `quote()`'s normalizer. It reads `l.from/.to/.distanceKm` per element,
  buffers per leg, and feeds the entire ops money pane (per-leg price, km strip,
  minimum-applied flags). It must share the same normalizer and per-ride buffer, and
  `LegBreakdown` needs a stops-aware shape (keep `from`/`to` populated from
  `stops[0]`/`stops[last]` for back-compat consumers, add `stops`). Without this,
  Phase 2 ships a broken estimate pane.
- The **public** `POST /quote` / `/quote/lock` Zod schema (`routes/quote.ts`) stays
  strictly leg-only — deliberately. It is the enforcement point for the ops-only
  decision: a `Ride` posted there 400s at validation. Only the ops route widens.
- No DB change. No route change beyond the ops schema (Phase 2).

### Ops quote tool — Phase 2

- `internalQuote.ts` `ToolLegSchema`: accept `stops: string[]` +
  `segmentKms: (number|null)[]` (§5); keep `from/to/distanceKm` accepted and normalized
  (old stored quotes reopen cleanly). `resolveLegKm` → per-segment loop. `toEngineRequest`
  passes rides through. Leg `category` and the sightseeing/waiting/safari fee flags stay
  **per-ride**.
- `ops-ui.html`: the leg card's pickup/dropoff pair becomes an ordered stop list —
  add/remove/reorder stop, "and return" button that appends a copy of the first stop
  (pure UI sugar; the model is just the list). Per-segment km display with manual edit;
  per-ride drive-time total (§5). The duplicate-and-swap workaround for returns is
  retired (dupLeg itself stays — it's useful for repeated days; it copies the whole stop
  and segment arrays verbatim). Known UI guards multiply per stop input: the autocomplete
  reopen-on-render guard (`_menuWasOpen`) and location-sync-on-pick/blur both apply to
  every stop field.
- **State rework (the real cost center, per audit):** the leg's distance state is a
  single scalar today — `distanceKm`, `driveTimeHours`, `manualDistance`, `autoMatched`
  all per leg, with the resolve debounce/cache keyed by leg id and the "place changed →
  clear manual" guards in the autocomplete pick/blur handlers. All of this becomes
  per-segment arrays with the §5 structural invalidation rule; the resolve cache re-keys
  by (from, to) pair. The DOM/focus contract also generalizes: inputs are addressed as
  `data-field="pickupLocation"|"dropoffLocation"` (a fixed two-value enum used by focus
  restore, autocomplete attach, *and* ~9 Playwright specs) → per-stop hooks
  (`data-field="stop"` + index). `routeText()` is the single choke point for the leg
  card, map captions, and the WhatsApp/email quote message — switching it to the joined
  stop list updates all three. The map already renders waypoints (`itinStops` →
  `drawItinRoute`), so the multi-stop map is nearly free.
- **stay_day is exempt from stop lists** (decision): it stays a single-location,
  non-driving special case exactly as today; the ride model applies to driving legs only.
- **dupLeg must deep-clone** `stops`/`segmentKms` — its current `Object.assign` shallow
  copy would share the arrays between original and duplicate.
- Quote presentation: the breakdown line and the customer-facing quote message render the
  joined stop list (`Habarana → Anuradhapura → Thanthirimale → Anuradhapura`). Phase 2
  DoD includes eyeballing this in the real quote message format — labels must stay
  readable at 4 stops. (Audit confirmed no server-side email/PDF renders quote line
  items — the quote message is generated client-side in ops-ui, so this is the only
  rendering surface.)
- Reopen path: old-shape quotes normalize on load. Note this is a **client-side**
  normalizer in ops-ui's reopen mapping (`tl.stops || [tl.from, tl.to]`), a separate
  code path from the engine's — both must agree and both get tests. Reopen's
  manual-inference (`km > 0` ⇒ manual) applies per segment (§5).
- Minor endpoint scans to sweep in Phase 2: airport-detection string scan,
  `hasBuiltItinerary`, and `addLeg`'s chain-from-previous all read pickup/dropoff and
  must read the stop list (first/last/any).

### Customer website — Phase 3a: signpost only (owner decision 2026-07-20)

The website does **not** get multi-stop building. Instead, one line of copy near the
transfer route picker: *"Want a stop along the way, a day trip and back, or a longer
route? Message us — we'll price it in minutes."* (Exact copy + placement at
implementation; links to the existing contact/WhatsApp affordance.) No pricing change, no
booking-flow change, no front-end mirror change — the FE/BE parity surface is untouched.

### Customer website — Phase 3b (trip builder) — OUT OF SCOPE, own spec

The trip flow (`tripStops/tripNights/...` parallel arrays in booking.js, derived legs,
`tripRequests` arrays in the DB) becomes a list of rides with gaps (implied stay = last
stop of the previous ride; optional nights per gap; non-chaining allowed with a gentle
confirm). This is the deepest rework and gets its own spec; nothing in phases 1–2 blocks
or presupposes it. Tours slot in there as prefilled ride lists (tours-as-suggestions).
Whether customers ever get self-serve multi-stop building is decided then, informed by
what ops learns quoting these manually.

### DB

**No schema migration in any phase of this spec.** `quotes.requestJson/resultJson` store
whatever shape was sent; `tripRequests` is untouched until 3b.

## 7. Phasing and rollout

Trunk-based: each phase is its own PR to `main` → auto-deploys to staging → verify →
promote `main → production` via PR. Sequential, one-thing-per-PR.

1. **Phase 0 — golden fixtures.** A tiny PR that captures current `quote()` outputs for a
   corpus of old-shape requests (unit fixtures + a few sanitized real `requestJson`
   samples) and commits them as snapshot tests against the **pre-change** engine. This
   must land (or at minimum be generated from `main`) *before* the refactor, or the
   safety net is circular.
2. **Phase 1 — engine.** Ride types, normalizer, per-day pricing per §4.
   *DoD:* Phase 0 goldens reproduce deep-equal (labels, warnings, meta, cents);
   black-box engine tests pass unchanged (unit tests of internal helpers may be updated
   to new signatures); multi-stop fixtures priced correctly; `npm run check` green.
   Staging soak with a replayed stored request or two.
3. **Phase 2 — ops tool.** Schema widening, per-segment resolve, stop-list UI, reopen
   normalization, catalog pre-check (§5). *DoD:* the sample itinerary above can be quoted
   as 7 rides in one quote — point-to-point, and as chauffeur after adding the reposition
   day (§4 note) — with the quote message rendering checked; an old stored quote reopens
   and reprices identically; e2e spec added covering mixed manual/auto segments **and the
   existing ops e2e suite (`quote-tool.spec.js`, `ops-ui.spec.js`) migrated off the
   two-endpoint `data-field` selectors** — that migration is in-scope Phase 2 work, not
   incidental breakage.
4. **Phase 3a — website signpost.** Copy only; can ship any time after Phase 2.
5. **Phase 3b — trip builder.** Separate spec first.

## 8. Testing strategy

- **Equivalence (the safety net):** Phase 0 golden corpus, captured from the pre-change
  engine, reproduced deep-equal by the new engine (§7).
- **New behavior:** one floor per multi-stop ride; **one buffer per ride** (95 raw km
  buffers as one day, not per segment); out-and-back; hybrid; floor-hit warning label;
  protected minimum ×rides; chauffeur multi-stop travel day; consecutive-duplicate-stop
  rejection; stop cap; null-segment auto-resolve.
- **Fixture:** the §1 sample itinerary end-to-end — 7 rides, priced point-to-point, and
  as a chauffeur span (16–25 Aug: 10 days, travel days incl. the 17 Aug reposition, rest
  idle).
- **Ops route:** per-segment resolution (incl. one manual + one auto segment in the same
  ride), structural invalidation on insert/delete/reorder, old-shape reopen, Zod
  validation.
- **Pin the booking path (audit finding):** add a test asserting a 3-stop customer trip
  booked via `/bookings/trip` still prices as **2 floored pairwise legs** (`priceTrip`
  behavior), never one collapsed ride. Nothing pins this today, and it is the hinge the
  "website untouched" claim hangs on — a well-meaning Phase 1/2 change that rewired trip
  booking to build one `Ride` would silently drop the checkout total below the shown
  estimate.
- **Web:** the customer suite (offline Vitest + Playwright) needs no changes — verified:
  the FE only emits legacy 2-stop legs, reads back only `quoteId`/totals, and the
  backend-price-parity guard actively protects the N-legs=N-floors invariant. The
  `CH_E2E_API` ops specs are Phase 2 scope (above), not "web" in this sense.
- **Test blast radius (expected, Phase 1):** internal-helper suites
  (`private.test.ts`, `chauffeur.test.ts`, `breakdown.test.ts`, `services/pricing.test.ts`)
  update to new signatures; black-box suites (`engine.test.ts`, `quote.test.ts`,
  `internalQuote.test.ts`, `quotedTotal.test.ts`, `smoke.test.ts`) must pass unchanged —
  they are the real safety net alongside the Phase 0 goldens.

## 9. Parked decisions (explicitly not in this change)

1. **Wait-time calculator (ops)** — the owner-chosen successor to manual fee flags:
   price each stop's dwell time explicitly in the ops tool, so stop-heavy days carry a
   proper premium and margin reflects driver hours. Design when Phase 2 usage shows the
   shape of real dwell patterns.
2. **Nights-per-gap for dateless chauffeur quotes** ("from $X — tell us your nights to
   firm up") — belongs to 3b; ops always has dates in practice.
3. **Per-ride times** (the sample's pickup windows) — notes field for now.
4. **Ride-level copy rename** ("Leg" → "Ride") in ops UI.
5. **Self-serve multi-stop building** — revisit at 3b with ops learnings.

## 10. Risks

| Risk | Mitigation |
|---|---|
| Silent price change to existing flows | Phase 0 golden corpus + unchanged black-box tests; 2-stop maths provably identical; old shape = de facto feature flag |
| `quoteBreakdown()` bypasses the normalizer → broken ops estimate pane | breakdown.ts added to Phase 1 scope (§6); breakdown tests updated with it |
| Warning-string spacing breaks golden equivalence | 2-stop warnings keep the exact no-space `A→B` form (§4); goldens enforce it |
| Trip booking route accidentally collapses stops into one ride → checkout total drops below shown price | `/bookings/trip` pin test (§8) |
| Ops-vs-web price divergence for the same multi-stop day during the ops-only window | Documented + owner-acknowledged (§4); resolved at Phase 3b |
| Multi-stop days price low (waiting unpriced) | Ops-only rollout — a human sees every price; manual fee flags; wait-time calculator later (§9.1) |
| Margin overstated on stop-heavy days | Documented caveat (§4); resolved properly by the wait-time calculator |
| **Discounts spec conflict (M18):** its leg-count conditions change meaning when N legs collapse into 1 ride | Before M18 build starts, amend the discounts spec to define counting (rides vs segments) — flagged to owner now |
| Old stored quotes break on reopen/reprice | Single normalizer at engine entry + ops-load normalizer; tested with real requestJson |
| Per-segment manual-distance regressions in ops UI | Structural invalidation rule (§5) + e2e covering mixed manual/auto segments |
| Via-stop POIs missing from known-places catalog → bad geocodes | Phase 2 catalog pre-check (§5); existing >900 km rejection backstop |
| Distance Matrix call growth | One call per segment, ≤7 per ride at the 8-stop cap; negligible cost |
