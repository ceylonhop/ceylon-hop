# API-driven customer prices

**Date:** 2026-08-12
**Status:** approved in principle by owner 2026-08-12 · revised twice after review · implementation
plan to follow
**Reverses:** `2026-07-22-rate-card-hot-zones-design.md` constraint **C1**, cadence **Option A**,
and the Phase 3 shape in §8.3. That spec carries a banner pointing here.

## Decision

The backend becomes the only thing that computes a price. The browser sends **intent** — places,
vehicle, passengers, bags, date, extras — and displays the cents it is given.

Distances are served from a **database cache** rather than a live Google call per price
(owner, 2026-08-12). This replaces the earlier "defer caching" decision.

## Why

The pricing formula currently exists twice — in the engine, and mirrored in front-end JavaScript,
held together by parity tests. Every pricing feature must be built twice and proven to agree.

It is already blocking work: the hot-zones spec records that its Phase 3 is a **prerequisite for
public automatic promotions** (`2026-07-15-discounts-design.md` §18.2). Under API-driven pricing
that prerequisite disappears, along with the parity tests, the regenerate-and-deploy cadence, and
the drift window between an ops change and a site deploy.

The immediate symptom is hot zones: a founder-set premium ("Ella +15%") applies to ops quotes but
not to website prices, because the website has no zone code.

## Step 0 — measure the problem first

Count how often `price mismatch` (`bookings.ts:246`, `:514`) fires in production, and at what
magnitudes.

This does not change the destination, but the justification for this work is currently
**unmeasured**. If the log has never fired, this is an architectural investment for future pricing
features — worth doing, but it should be described as that.

## Architecture

```
browser  --intent-->  POST /quote/v2/estimate
                          |
                          +-- compose RATE_CARD + activeZones()      (one shared helper)
                          +-- distance per leg:  cache hit  ->  DB
                          |                      cache miss ->  Maps, then write back
                          +-- quote()
                          |
         <--cents--------  +   totalCents, per-leg breakdown, durations, estimated flag
```

The foundation exists. `WebQuoteIntentSchema` (`api/src/quote/webQuoteV2.ts`) accepts place names
with no distances; `engineRequestFor()` (`api/src/routes/quote.ts:49`) resolves them server-side
and prices them. It is gated behind `QUOTE_V2_ENABLED`, default false, and is exercised today only
by `/quote/v2/lock`.

Caveat: quote v2 is two security-scoped commits, unit-tested for `/v2/lock` only, no e2e coverage.
Sound foundation, not battle-tested.

## Distance cache (replaces "deferred caching")

A DB table of resolved distances, so a price is a database lookup rather than a billed Google call.

**Precedent to follow:** `placeResolutionRepo` + `PlaceResolver`
(`api/src/services/placeResolver.ts`) is already a DB-backed cache of canonical place →
coordinates, with the rule that a geocode may *identify* a known place but never *introduce* one.
The distance cache is its direct analogue and should reuse **`canonPlace()`** as its key.
Normalisation ("Ella" vs "Ella, Sri Lanka" vs whatever the customer typed) is what silently makes
a cache never hit, and that problem is solved there already.

**Shape:** `from_key`, `to_key`, `km`, `duration_min`, `source`, `fetched_at`.

**Directional, not symmetric.** `REAL_KM` treats A→B and B→A as identical; real routing does not
always agree, and rows are cheap. At ~41 places this is under 2,000 rows.

**Rules:**

1. **Never store an `estimated` result as authoritative.** `maps.ts:272` returns a haversine
   fallback flagged `estimated: true` when Google is down. Writing that in as real routing would
   poison prices permanently. Store it flagged, or not at all, so a later refresh can upgrade it.
2. **Refresh is manual, with a timestamp.** No TTL. A price change should be a deliberate,
   reviewable act — not something Google's routing changes under you.
3. **Only trusted places mint rows.** The `PlaceResolver` rule applies: an arbitrary typed string
   must not create a permanent cache entry.

**Seeding:** step 2's comparison report already has to fetch every catalogue pair. That job **is**
the seed job — run once, deltas reviewed against today's baked numbers, reviewed output populates
the table.

**What this buys:** cost drops to near zero after warm-up; a Postgres lookup replaces a Google
round-trip, which is what makes the latency budget below achievable rather than aspirational;
prices stop drifting when Google silently reroutes; and `REAL_KM` is replaced properly — same data,
server-side, single-source, refreshable.

**This is a migration.** Per the house rules, merging it *is* releasing it — pending migrations
auto-apply on Render boot, so it reaches staging the moment it lands on `main`. Flagged at PR time,
not presented as a deploy step. Needs the owner's explicit go.

## Backend work

**One shared rate-card composition.** `internalQuote.ts:672` builds it in a single line —
`{ ...RATE_CARD, hotZones: await zonesRepo.activeZones() }`. Lift it into a helper used by ops,
`quoteRoutes` and `bookingRoutes`, so "the website prices exactly like ops" is true by
construction. `quote()` already accepts a rate card as its second argument, so no signature change
is needed.

**Zones reach the customer path.** `app.ts` passes the `zones` repo to `quoteRoutes` (`:377`) and
`bookingRoutes` (`:328`).

> **No new hot-zone logic is written — anywhere** (owner, 2026-08-12). The engine already owns all
> of it: `hotZones.ts` matches, `private.ts:51` applies the boost via
> `winningZoneForStops(ride.stops, rateCard.hotZones)`, `zonesRepo.activeZones()` reads the
> founder's list, and `quote(req, rateCard)` already accepts the composed card. Populating
> `rateCard.hotZones` on the customer path **is** the entire change; the boost then happens inside
> the engine, unchanged. The front end never sees a zone, a boost percentage, or a matching rule —
> it receives a total. Any proposal that reimplements matching or boosting outside the engine is
> out of scope by construction.

**`POST /quote/v2/estimate`.** Prices without persisting — ops has this split (`/estimate` vs
`/save`); the customer side has only the persisting `/v2/lock`. Rendering a price must not write a
`quotes` row. Returns per-leg **duration** (`DistanceResult.durationMin` already carries it) so the
site stops deriving it locally, and an **`estimated`** flag (below).

**Expand `KNOWN_PLACES`.** The server knows **21** places (`maps.ts:109`); the front end resolves
about **41** — 25 in `PLACES` plus 16 in `EXTRA`, with fuzzy matching. Dambulla, Udawalawe,
Tissamaharama, Tangalle, Unawatuna, Hatton, Adam's Peak, Wilpattu, Kalpitiya, Jaffna, Haputale,
Kitulgala, Hiriketiya and Ahangama resolve today and would stop resolving server-side. Without this
in step 1, step 3 breaks the planner.

**Warm-up ping on price-bearing pages.** `booking.js:14` pings `/health` on load; landing and
browse pages do not — the snippet in `index.html` is an error beacon, not a warm-up.

## Estimated prices (replaces the client-side fallback)

An earlier draft kept a frozen front-end estimator for cases the API could not price. **That was
unnecessary** — the backend already has the same fallback: `maps.ts:266` falls back to
`offlineEstimate` (crow-flies × 1.35, the identical model) and flags it `estimated: true`.
`engineRequestFor` currently *rejects* those legs, which is the only reason `quote_unpriced` fires
as often as it would.

So: `/estimate` returns an engine-computed price carrying `estimated: true` rather than refusing.
Same labelling, same coverage, **one implementation** — which is the point of the project.

Rules:

1. **Labelled.** An estimated price renders as approximate, confirmed at checkout — never as a firm
   quote.
2. **Never transactable, enforced on the server.** `bookings.ts:74` currently resolves an unpriced
   booking to `max(quotedTotal, placeholderTotal)` — a client-supplied figure can become the
   charge. A UI rule alone does not make this safe. The server must refuse to create a booking
   whose price derives from an estimated distance.

The only remaining case with no server answer is "API unreachable or no backend configured". That
gets an honest unavailable state, not a second pricing implementation.

## Rate limiting and cost control

**Correction to an earlier review note:** `/quote/*` *is* already rate limited — `app.ts:277`,
deliberately wildcarded so `/quote/lock` could not slip through. `/quote/v2/estimate` inherits it.
The limit is **20 POSTs per 60 s per IP** (`RATE_LIMIT_MAX`, `RATE_LIMIT_WINDOW_MS`,
`config.ts:56`), keyed on the rightmost `x-forwarded-for` entry so it cannot be spoofed behind
Render.

Two gaps remain:

- **Requests are capped; elements are not.** The intent schema allows 16 legs (private) or 31
  travel days (chauffeur) per request. Twenty requests a minute can therefore be ~620 distance
  lookups a minute. Cap elements per request, not just requests.
- **Set a hard daily quota cap in the Google console.** It is free and it is the only backstop that
  survives an application bug.

With the distance cache in place both of these bound an already-small exposure, but the cache is
the fix and these are the guard rails.

## Client work

One module, `ch-pricing.js`, exposing `estimate(intent)` and owning fetch, in-flight
de-duplication, timeout, and loading/failure state. Consumers render what it returns.

**Products covered: private and chauffeur only.** Shared-seat prices are flat corridor rates, not
distance-priced, and hot zones exclude shared rides (hot-zones spec D8). `board.js` and the
shared-ride cards keep the generated corridor-seat constants. Pushing them through a
distance-priced intent API would be a worse fit, not a purer one. **However** `bookings.ts:487`
prices shared through `priceShared` server-side, so the displayed constant and the charged figure
must be parity-tested — that is the same divergence class this project exists to close.

**Surfaces to convert:** `booking.js`, `search.js`, `plan.js`, `tours.html`, `tour.html`,
`index.html`, `why.html`, `site.js`.

**Hand-typed prices removed:** the `price:` literals in `tours-data.js`, shown today as
"chauffeur-guide from $520".

**Stays, and must be commented as non-pricing:** `exactSpotDecision`'s haversine guard, the place
list and suggestions, and any `EXTRAS` constants used for UI copy such as "+$10".

## Latency budget

Measured on staging against a warm instance:

- `/quote/v2/estimate` **p50 < 800 ms, p95 < 2.5 s**.
- Client timeout **3 s**, after which the surface shows its unavailable state.

The distance cache is what makes this realistic — a DB lookup rather than a Google round-trip.
Step 4 does not proceed until p95 is inside budget with the warm-up ping in place. The measurement
mechanism must be named in the implementation plan; it does not exist today.

## Sequence

Ordered so a mistake surfaces on a screen rather than on an invoice.

0. **Measure.** `price mismatch` frequency and magnitude in production logs.
1. **Backend foundation.** Shared helper, zones into the customer path, `/quote/v2/estimate` with
   the `estimated` flag, `KNOWN_PLACES` expansion, server-side non-transactable rule, element cap,
   warm-up ping. No client change. **With zero active zones this moves no prices** — the only step
   of which that is true.
2. **Distance cache + comparison report.** One job: fetch every catalogue pair, rank baked `REAL_KM`
   vs live Maps deltas, owner reviews, reviewed output seeds the table. Includes the migration.
3. **Booking flow.** `booking.js` prices through `ch-pricing.js`. The money path moves first.
4. **Browse surfaces.** search, plan, tours, tour, index, why — gated on the latency budget.
5. **Remove the mirror.** Delete `legPrice`, `distancePrice`, `finishPrice`, `tripQuote`,
   `privateQuote` and the pricing role of `@generated:pricing`; retire
   `backend-price-parity.test.js`, which asserts an agreement that no longer has two sides.

Steps 0–2 are safe at any time apart from the migration gate. Step 3 onward changes what customers
see and wants staging observation before promotion.

## This is a repricing event, not just a refactor

From step 3 the site prices off cached live-Maps distances rather than `REAL_KM`, a hand-baked
matrix of unknown vintage with six entries self-flagged "road estimates (refine with Google
Directions)". Prices will move for reasons unrelated to hot zones.

Step 2 exists to quantify that **before** step 3, so the movement is a reviewed decision rather
than a discovery.

## Hot zones are a live price change

Once step 1 ships and a zone is active, customers pay the premium ops already quotes. If any zone
is active in production this needs explicit owner sign-off and a delta report before promotion to
`production`. If none are active, step 1 moves no prices.

`HOT_ZONES_DISABLED=1` remains the one-flip kill switch.

## Testing

- `/quote/v2/estimate` returns a priced result and persists no `quotes` row.
- A zone-touching route prices higher than an equivalent non-zone route through `/quote` **and**
  `/bookings`.
- Ops and customer paths compose an identical rate card for identical input.
- Cache: a hit does not call the Maps adapter; an `estimated` result is never stored as
  authoritative; `canonPlace` variants of the same place hit the same row.
- Server refuses to create a booking priced from an estimated distance.
- Shared-ride parity: the generated corridor-seat constant equals `priceShared`'s figure.
- E2E: rendered price equals the stubbed API's cents (`web-tests/e2e/_stubs.js` already stubs
  `/quote/lock`; `/quote/v2/estimate` follows the same pattern).
- E2E: an estimated price renders labelled, and checkout is blocked on it.
- E2E: a lock total differing from the shown estimate forces acknowledgement before payment.

## Estimate vs lock

The locked price is authoritative and a change is never silent: if `/lock` returns a different
total than the estimate shown, the UI surfaces it and requires explicit acknowledgement before
payment.

With the distance cache, estimate and lock read the same rows, so disagreement narrows to an edited
zone or a refreshed cache between the two.

## Footprint

Eight front-end files, the booking path, and one new table, on a codebase in maintenance mode near
launch. Larger than the house rules' default, entered deliberately with the owner's decision
recorded here.

## Appendix — full front-end call-site inventory

Enumerated by grep, not by memory. `transfers-data.js` itself is excluded (it is the module being
retired).

### There are three distance sources today, not one

1. **Baked `REAL_KM`** (`transfers-data.js:101`) — known catalogue pairs.
2. **Haversine × 1.35** — anything not in that table.
3. **Live browser-side Google Directions** — `plan.js:92` calls `window.CH_MAP.routeStats([a,b])`
   for legs whose endpoints don't resolve to known places (`ch-map.js:461`). This runs on the
   **browser** Maps key and is billed today.

Source 3 was not accounted for in earlier drafts. Retiring it is part of this work, and it moves
that spend from the browser key to the server key.

### Per file

| File | Sites | What lives there |
|---|---|---|
| `booking.js` | ~31 | `tripQuoteWithKms` wrapper (`:99-146`), `privateQuote` (`:168`), `legPrice` (`:117,524`), `distancePrice` (`:1141`), `finishPrice` (`:949,950,1176`), `billableKm` (`:1135`), `kmBetween` (`:234,499,1759,1799`), `durationText` (`:124,500,515`), `repriceDecision` (`:519`), `CHAUFFEUR_DAY_FEE` (`:1125`), `CHAUFFEUR_IDLE_MIN_KM` (`:1133`), `DEPOSIT_PCT`/`DEPOSIT_CAP` (`:1180-1182`), `EXTRAS` (`:1040`), `FLOORS` (`:1174-1175`) |
| `plan.js` | ~19 | local `legPrice`/`roadKm`/`durationText` wrappers (`:116,59,107`), `finishPrice` (`:128,481`), `minLegPrice`/`FLOORS` (`:119-122`), `guidePriceRange` (`:124-131`), `DAY_FEE` (`:167`), live-km cache + waiters (`:67-105`) |
| `index.html` | 3 | `privateQuote` + `sharedOption` quote widget (`:635-636`), `tripQuote` for tour cards (`:650`) |
| `tour.html` | 3 | `tripQuote` + `finishPrice` + `FLOORS` (`:537-539`) |
| `tours.html` | 3 | `tripQuote` + `finishPrice` + `FLOORS` (`:206-208`) |
| `why.html` | 2 | `privateQuote` + `sharedOption` comparison widget (`:187-188`) |
| `search.js` | 2 | `privateQuote` + `sharedOption` (`:109-110`) |
| `board.js` | 2 | `sharedOption` (`:1093,1107`) — **shared product, out of scope** |

**`site.js` is not a pricing surface.** Its `window.TRANSFERS` uses (`:158,168,179`) are place
autocomplete only. Earlier drafts listed it in error.

### Four things the inventory changed

**`plan.js` is not a thin consumer.** It has its own display layer — `guidePriceRange` turns a
total into an indicative band ("$120–$145") with a $10 cushion and a vehicle-minimum clamp. That is
pricing *presentation* logic which must be preserved or deliberately re-specified; it is not a
passthrough that can simply call the API.

**`plan.js:167` carries a stale hardcoded price.**
`const DAY_FEE = (window.TRANSFERS && window.TRANSFERS.CHAUFFEUR_DAY_FEE) || 55;` — the real fee is
**31.05**. If `transfers-data.js` fails to load, the planner quotes the chauffeur day rate 77% high.
This is a live hazard today, independent of this migration, and should be fixed separately rather
than folded in here.

**`booking.js` sends client-computed distance to the server.** `:1759` and `:1799` put `kmBetween`
results into the booking payload — the legacy "client supplies distance" contract. Severing that is
a required step, not an incidental cleanup.

**`repriceDecision` is a live behaviour, not a formula.** `booking.js:519` decides hold-vs-reprice
when a customer pins an exact pickup spot. Under API pricing this becomes a round trip, and its
companion guard `exactSpotDecision` (the ≤10 km sanity check) stays client-side as a non-pricing
check.

### Non-pricing uses that must survive

`durationText` (display), `kmBetween`/`roadKm` (distance display), `exactSpotDecision`, place lists
and autocomplete, and `EXTRAS` for add-on labels — unless the estimate response carries per-extra
amounts, in which case the labels come from the API too.

`CORRIDOR_SEAT` is consumed only inside `transfers-data.js` to build `CORRIDORS`, which confirms the
shared-ride carve-out: shared seat prices stay generated.

## Risks

- **Silent money bugs.** A pricing error surfaces as a wrong charge, not a crash. Mitigated by
  money-path-first ordering, step 2's report, and the server-side non-transactable rule.
- **Prices move at step 3** from the distance-source change — quantified by step 2.
- **Stale cache rows.** Manual refresh means a road change is invisible until someone refreshes.
  Accepted deliberately: predictable prices beat self-updating ones.
- **Cold starts** on the free tier — mitigated by the warm-up ping, removable by a paid instance.
- **Quote v2's thin coverage** — addressed in step 1 before anything depends on it.
