# Planner: stops within a leg — design

**Date:** 2026-10-30 · **Owner decision:** stops behave exactly as they do in the ops quote
tool · **Status:** approved UX (mock at `docs/prototypes/planner-stops-ux.html`), awaiting
implementation plan.

Code references are to `origin/main` @ `40f999ca` unless stated.

## 1. Problem

The customer planner (`plan.html` / `plan.js`) only knows legs of two places. A traveller who
wants Kandy → Pinnawala → Sigiriya in one day has to add two transfers, which reads (and is
priced, and reaches ops) as two separate rides. The ops quote tool already models this as one
leg with a chain of stops (`ops-ui.html:5750`, `stops: ['', '']` + one segment per pair), and a
booking already stores it as one `day`/`leg` row with `viaStops` (`api/src/db/schema.ts:339`).
The customer side needs the same.

## 2. Definitions (same as ops)

- A **stop** is an extra place inside one leg: Pick-up → Stop → … → Drop-off, same day, same
  vehicle. It is a place only — no duration, no per-stop fee. Waiting/sightseeing fees stay an
  ops add-on, as today.
- A leg with stops is **one ride** for pricing: the per-km rate applies to the sum of its
  segment distances, with one minimum fare, not one per segment (`api/src/quote/private.ts`).
  A stop in a hot zone boosts the whole ride (`winningZoneForStops`), as ops does.
- A leg has **no price while any segment is unmeasured** (`legKm`, `ops-ui.html:5790`). The
  planner never shows a partial sum as the leg's price.
- **Only consecutive repeats are invalid** (`legChainDuplicate`, `ops-ui.html:5811`;
  `validateRide`, `api/src/quote/types.ts:64`). Kandy → Pinnawala → Kandy is a valid round trip
  and prices on both segments.
- A **stay** card cannot have stops (ops rejects stops on a `stay_day`).
- The **toll / local-road choice** applies only to a plain two-place leg. Adding a stop clears
  it (ops GC-10). The planner's road chip disappears; the summary's "via" line follows.
- Caps: ops allows 8 places per leg. The public side caps at **4 stops per leg (6 places)** and
  **12 places per trip** (`MAX_TRIP_STOPS`, `api/src/domain/trip.ts:12`) because each segment is
  a billed Google lookup. "Add another stop" hides at the cap.

## 3. UX (approved)

Five states are drawn in `docs/prototypes/planner-stops-ux.html`, using the real planner card
styles. Only the stop row, the hover controls and the acknowledge buttons are new CSS.

### 3.1 The card

- A leg card keeps its header (badge, distance · time · source, "from $X", ×) and its vertical
  rail. A stop is a row on that rail between Pick-up and Drop-off: solid teal dot, label
  **"Stop on the way"**, a place input wired to the same place search as the endpoints.
- Card foot, right-aligned, quiet link: **"+ Add a stop on the way"** on a two-place leg,
  **"+ Add another stop"** once it has one. Not shown on a stay card. Disabled at the cap and
  while the leg has a hard-stop error. The label never names the leg number: the link sits
  inside the card, and "on the way" is what distinguishes it from the page-level "+ Add another
  transfer".
- Adding a stop inserts an empty row directly above Drop-off and focuses it.

### 3.2 Row controls (hover)

Every row — Pick-up, each Stop, Drop-off — shows a `⇅ ×` pair at its right edge on hover or
keyboard focus; always visible where there is no hover (touch). At rest the card is just the
places on the rail.

- **⇅** swaps that place with the one below; on the last row, with the one above. On a
  two-place leg this is today's pick-up/drop-off swap. The old swap button on the divider is
  removed.
- **×** removes that place. Removing Pick-up makes the first stop the new Pick-up; removing
  Drop-off makes the last stop the new Drop-off. Not shown on a two-place leg (a leg needs two
  places); the header × still removes the whole card.
- Drag-to-reorder stays at card level. Stops travel with their card. No drag within a card.

### 3.3 Header, summary, map

- Header distance/time/price cover the whole chain. While any segment is still being measured
  the header shows the shimmer, not a number.
- Trip summary: the route line lists every place ("Kandy → Pinnawala → Sigiriya → Ella").
  "Places" counts stops; "Transfer legs" does not.
- Map: one route per leg drawn through its stops (`ch-map` already takes a `stops[]` per run,
  `plan.js:1292`). A place that appears twice (round trip) gets one marker, as ops does
  (`SAME_PLACE` merge, `ops-ui.html:13484`).

### 3.4 Hard stops (block "Next")

Errors, never choices. Red card border (`.leg-card.leg-bad`), red note under the rail, header
reads "Fix the route to see distance & price", "Add another stop" disabled, the "Next: add your
dates" button disabled with "Fix Leg N to continue".

| Check | Copy |
|---|---|
| Same place twice **in a row** (stop = next stop, or stop = drop-off, etc.) | **Same place twice in a row.** The stop and the drop-off are both Sigiriya — remove one, or change it. |
| A segment with no distance (unknown place) | existing "Pick both points — Google fills in distance & price" state, per row |

### 3.5 Soft warnings (ask, then allow)

A judgement call the traveller must answer; ops still reviews every booking, so the answer is
recorded, not enforced.

**Long day on the road** — any leg whose total drive time is ≥ 6 h (ops `Long drive warning`
threshold, `ops-ui.html:10793`). Amber note under the rail:

> **Long day on the road.** Kandy → Pinnawala → Sigiriya → Ella is about 7 hours of driving,
> before any time at the stops. Most travellers split this with a night in Sigiriya.
> [ Split it — end this leg at Sigiriya ]  [ Keep it as one day ]

- **Split it** makes the last stop the Drop-off and adds a new leg from there to the old
  Drop-off (pre-filled, like "Add another transfer"). One click, no retyping. The suggested
  split point is the stop that leaves the two halves closest to equal time.
- **Keep it as one day** records `ack: 'long_day'` on the leg. It clears if the leg's places
  change. "Next" is disabled with "Answer the note on Leg N to continue" until one is chosen.
- The acknowledgement reaches ops with the booking (§4.4).

Applies to two-place legs too (Colombo → Arugam Bay is 7 h today and shows nothing). That is
a behaviour change on existing legs and ships in the planner PR with this feature.

### 3.6 Out of scope here (own PRs, listed so they aren't forgotten)

Promoting "Dates out of order" (`plan.js:1475`) and an unmarked gap between legs to hard
stops, and a "Hectic itinerary" ask at the dates step (3+ driving days in a row). All three
change the existing planner independently of stops.

## 4. Data flow and API

Three layers carry a stop today for ops; the public path needs the same field at each.

### 4.1 Quote intent — `WebQuoteIntentSchema` (`api/src/quote/webQuoteV2.ts`)

Add to each private `legs[]` item and each chauffeur `travelDays[]` item:

```ts
via: z.array(Place).max(4).default([])
```

- `engineRequestFor` builds one `Ride { stops: [from, ...via, to], segmentKms }` per leg,
  measuring each consecutive pair through the existing memoized Maps adapter. Legacy two-place
  legs are unchanged (`via: []`).
- A leg with `via.length > 0` and a `routeVariant` is refused (`route_choice_not_supported`),
  mirroring ops GC-10.
- Cost bound: the intent is refused when `Σ (via.length + 1)` across legs exceeds **12
  segments** (today's 8 legs × 1). The comment at `webQuoteV2.ts:35` explaining why legs are
  capped is extended to say segments are what's capped now.
- `/v2/estimate-batch` keeps its catalogue-only rule: every place in the chain, stops included,
  must be a catalogue town or the intent returns `null`. A leg with an off-catalogue stop
  (Pinnawala) is priced by the planner through `/v2/estimate` instead — a billed lookup per
  segment, under the existing per-IP limiter. Accepted cost (owner, 2026-10-30).
- `fingerprintIntent` already canonicalises nested arrays, so `via` is part of the fingerprint
  with no change.
- `quoteToBooking` / `customerQuoteView` already consume `Ride.stops` (`chainStops`,
  `mapRunsOf`), so a locked quote with stops renders and converts without change. Verified by
  a golden test, not assumed.

### 4.2 Trip booking — `TripInput` (`api/src/domain/trip.ts`)

The booking wire is a flat chain (`stops[]`, with per-wire `dates[]`, `gaps[]`,
`routeVariants[]`). A stop is a member of that chain, so one new per-wire array:

```ts
through: z.array(z.number().int().min(0)).max(MAX_TRIP_STOPS).optional()
```

`i ∈ through` means wire `i` (`stops[i] → stops[i+1]`) is driven straight on: `stops[i+1]` is a
stop on the way, not an overnight, and the same leg continues on wire `i+1`. Rules:

- A wire cannot be both `through` and a `gap`. `nights[i+1]` must be 0 for a through wire.
  `dates[i+1]`, if sent, must equal `dates[i]`. `routeVariants[i]` must be empty on any wire
  that belongs to a leg with stops. Each violation is a 400 `invalid_request` naming the wire.
- Place count including stops stays under `MAX_TRIP_STOPS` (12).
- Pricing (`bookings.ts:779`): wires are grouped into rides at through boundaries; each ride is
  measured per segment and priced as one `Ride`. The stored request keeps the flat chain plus
  `through`, so nothing that reads `trip_request.stops` today changes meaning.
- Legs (`deriveTripLegs`, `api/src/domain/bookingLegs.ts:105`): `privateLegs` merges a through
  run into one `leg` row with `viaStops`; `chauffeurDays` already groups by date and gains the
  same merge. `checkBookingLegs` already chains `viaStops` back into the stop list
  (`checkBookingLegs.ts:163`), so the parity check holds.
- Storage: `trip_request` gains a `through int[]` column with a default of `'{}'`, like `gaps`
  (migration 0076 added `gaps`). **This is a migration** — it reaches staging on merge to
  `main` and prod on the promote; flagged here per the operating contract.

### 4.3 Planner → booking hand-off (URL)

`plan.js` `syncPlanUrl` / `booking.js` params: add `through=<wire indices>` alongside `gaps=`.
`nights` for a stop is always `0`. Nothing else in the URL changes. `booking.js` sends
`through` on the trip wire, shows stops under each leg in the summary, and includes them in
the quote intent as `via` when it prices.

### 4.4 The "kept a long day" acknowledgement

Reuse the booking's customer notes (#837), not a new column: `booking.js` appends one line per
acknowledged leg — `Planner: kept a 7 h day (Kandy → Pinnawala → Sigiriya → Ella), 12 Nov` — so
ops sees it was a choice. The planner passes `ack=<leg indices>` in the hand-off URL; the
booking page composes the line from the leg it refers to. The exact notes field name is
confirmed in the booking PR against `CustomerInput`.

## 5. Planner state model

`state.legs[i]` gains `via: string[]` (default `[]`) and `ack: 'long_day' | null`.

- Per-segment measurement: today a leg's distance is one `liveRouteKey(from, to)` lookup
  (`plan.js:868`). A leg with stops measures each consecutive pair with the same local table
  and live-route path, and sums. A round trip (from = to) is only meaningful per segment, which
  is why the key cannot stay leg-level.
- `routeSeq()` (`plan.js:479`) flattens legs into the place sequence; stops are appended with
  `nights: 0` and their wire index is pushed to `through`. The consecutive-merge there stays
  (it merges only adjacent repeats, so a round trip survives).
- `buildLegs(stops, nights, gaps)` (`plan.js:214`) gains `through` so a planner URL round-trips.
- `roadChoice` entries for a leg are dropped the moment it gets a stop.
- Hard-stop and soft-warning checks run in `render()` per leg; "Next" reads the aggregate.

## 6. Testing

- **API (Vitest, red → green):** `webQuoteV2` schema accepts `via`, refuses `via` + road,
  refuses > 12 segments; `engineRequestFor` builds a 3-stop `Ride` and prices it as one ride
  (a golden: Kandy → Pinnawala → Sigiriya ≠ Kandy → Pinnawala + Pinnawala → Sigiriya when the
  floor bites); `estimate-batch` returns `null` for an off-catalogue stop; `TripInput` rules in
  §4.2 each 400; `deriveTripLegs` merges a through run into one row with `viaStops` for private
  and chauffeur; `quoteToBooking` golden with a stop; Postgres contract test for the `through`
  column.
- **web-tests (Playwright):** add a stop, header price waits for both segments; consecutive
  duplicate blocks Next with the red note; round trip Kandy → Pinnawala → Kandy prices;
  ⇅ / × on each row; long-day note appears at ≥ 6 h, "Split it" produces two legs, "Keep it"
  enables Next and the `ack` reaches the booking URL; stay card has no add-stop link; road chip
  disappears when a stop is added; hand-off URL carries `through`; booking summary lists the
  stops.
- Visual states checked against `docs/prototypes/planner-stops-ux.html`.

## 7. Delivery

One step = one PR, in this order. Each leaves `cd api && npm run check` and `npm run test:all`
green.

1. **API — quote intent `via`** (§4.1). Schema, engine request, batch rule, goldens. No
   schema change, no rate card change.
2. **API — trip booking `through`** (§4.2). Migration + `TripInput` + `deriveTripLegs` + leg
   grouping in pricing. Owner's OK required before merge (migration).
3. **Booking page** (§4.3, §4.4). Reads `through`/`ack`, sends them, shows stops.
4. **Planner** (§3, §5). Card UI, controls, per-segment measurement, hard stop, long-day ask,
   map, summary, hand-off.

PR 1 and 2 are independent of each other; 3 depends on 2; 4 depends on 1 and 3.

## 8. Not doing

- Per-stop duration or waiting fee (ops has a separate add-on; same here — none on the
  customer side).
- Drag-reorder of stops within a card.
- Per-segment distance rows on the card (ops shows them for manual km entry; customers don't
  edit distances).
- Auto-posting the acknowledgement anywhere other than the booking notes.
