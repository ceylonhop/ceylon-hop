# Customer route choice — expressway or local road (search and plan pages)

**Date:** 2026-09-26, revised 2026-09-27 · **Status:** spec for owner review; nothing built ·
**Read from:** `origin/main` @ `59cb7158`. This is "Phase 2" of route choice, which the ops spec
deferred (`docs/superpowers/specs/2026-07-21-ops-route-choice-modal-design.md`, "Out of scope").

## 1. Problem

The ops quote tool offers a choice when a trip has a materially cheaper toll-free road. It
auto-opens a popup once per leg (`api/src/routes/ops-ui.html:11055-11064`, guard
`shouldPromptRouteChoice` at `:11075-11088`). The customer pages never do. A traveller searching
Colombo Airport → Ella, or planning a trip through it, sees only the expressway fare, even when a
slower local road would cost them less.

## 2. Owner decisions (chat)

1. **2026-09-26.** Replicate the ops popup on `search.html`. The owner reviewed a mockup in chat:
   a desktop popup, a phone bottom sheet, and a private-transfer card that keeps a road switch
   after the pick.
2. **2026-09-26. Auto-open once.** The switch stays so the customer can change their mind.
3. **2026-09-27. The plan page gets it too** ("it should"): every drive in a planned trip can
   offer the local road.
4. **2026-09-27. Sightseeing must keep working** with a chosen road (§4.8).
5. **2026-09-27.** The user stories in §2.1 were accepted as written.

### 2.1 User stories

These come from the owner's request and the design, not from customer research. The spike
(§5 step 0) tests only whether cheaper local roads exist on popular routes.

**Travellers**
- **Budget traveller.** As a traveller who cares more about price than time, I want to see a
  cheaper, slower local road when one exists, so I can save money.
- **Traveller with a flight.** As a traveller catching a flight, I want the fastest road to stay
  the default and be clearly labelled, so I don't book a slow road by mistake.
- **Traveller who hasn't decided.** As a traveller who dismissed the popup, I want to switch road
  later on the card, without the popup coming back every time I reload.
- **Trust in the price.** As a traveller who picked the local road, I want to pay exactly the
  price I was shown, and my confirmation email to say which road I booked.
- **Moving the pickup spot.** As a traveller who changes my exact pickup point on the booking
  page, I want to be told plainly if the local-road price no longer applies, rather than being
  charged a different amount silently.
- **Trip planner.** As a traveller planning several drives, I want each drive that has a cheaper
  local road to offer it, and adding or moving a stop to re-check the drives it changes.

**Ops and drivers**
- **Ops team.** As an ops agent, I want the booking sheet and the "Paid:" email to say "local
  road" for each drive that uses it, so I can tell the driver.
- **Driver, through ops.** As a driver, I want to know which road the customer paid for before I
  set off. The system has no driver view, so this story is met through the ops sheet.

**Owner**
- **Honest offer.** As the owner, I only want the offer to appear when the local road genuinely
  costs less. Otherwise the site nags people with a choice that saves them nothing.
- **Evidence it works.** As the owner, I want to see how often customers pick the local road.
  The ops rollout named this data as the reason to build the customer version
  (`docs/superpowers/plans/2026-07-20-route-choice-ops-quote.md:270`).

## 3. How it works today (verified)

### 3.1 The fork test

`MapsAdapter.distanceVariants(from, to)` makes two Google Distance Matrix requests in parallel:
the default route, and the same route with `avoid=tolls` (`api/src/adapters/maps.ts:305-312`).
It reports a choice only when both requests succeed **and** `isMaterialRouteChoice` holds: the
toll-free road is at least 45 minutes slower and the two distances differ by at least 15%
(`maps.ts:24-31`). Results are cached in memory for 24 h in the one adapter instance per process,
full successes only (`maps.ts:294, 319-322`; instance built at `api/src/server.ts:83-100`).

Owner figures in the offline fake (`maps.ts:216-219`):

| Pair | Expressway | Local road | Offered? |
|---|---|---|---|
| Colombo City → Ella | 292 km · 5h 30m | 205 km · 6h 30m | yes |
| Colombo Airport → Galle | 148 km · 2h | 130 km · 3h 25m | no, km gap is 12% |

### 3.2 In ops, the road is only a label; the km does the pricing

`routeVariant` on an ops leg is "passthrough only — distanceKm stays the sole pricing input"
(`api/src/routes/internalQuote.ts:80-83`). Picking a road writes that road's km into the leg in
the browser (`ops-ui.html:11145-11153`), and the ops tool sends km to the server. The customer
site can't work this way: its server never takes a distance from the browser.

### 3.3 Search and single-transfer booking can't carry a road

- **Estimate.** `POST /quote/v2/estimate` legs are `{ from, to }` with `.strict()`
  (`api/src/quote/webQuoteV2.ts:24-34`), so any extra key is a 400. The server measures each leg
  with `maps.distance()`, the fastest road only (`api/src/routes/quote.ts:68-75`). No public
  endpoint calls `distanceVariants`. The only caller is the ops `/admin/quote/distance`
  (`internalQuote.ts:795`).
- **Booking.** `booking.js` posts `/bookings/single` with `from`/`to`, and the server re-prices
  with `maps.distance()` (`api/src/services/pricing.ts:72-99`, called at
  `api/src/routes/bookings.ts:478`). `SingleTransferInput` is a plain `z.object`
  (`api/src/domain/singleTransfer.ts:82-97`), so an extra `routeVariant` key would be silently
  stripped. The rate lock (`POST /quote/lock`) freezes only the rate card, and the booking still
  measures the road itself (`bookings.ts:344-356, 475-478`).
- **Storage.** A single transfer is stored in typed columns on `transfer_request`
  (`api/src/db/schema.ts:98-115`). There is no road column and no JSON catch-all.

### 3.4 The plan page prices in the browser; trip booking prices every stop pair

- **No engine on the plan page.** `plan.js` makes no pricing requests (no `fetch`, no
  `CH_PRICING`). Each drive's km comes from a browser Google route, the baked table, or a
  crow-flies estimate (`plan.js:93, 101-136`). It is priced client-side with `legPrice(km)`
  (`:148`) and shown as "from $X" on the drive card (`distHtml`, `:519-533`).
- **Drives.** A drive is one transfer card. A 0-night stop between A and B makes two cards,
  A → stop and stop → B, priced separately (`routeSeqDetailed`, `:461-488`). A plan holds up to
  10 cards (`:396, 424`).
- **Hand-off.** `goToBooking` sends `mode=trip` with `stops`, `nights`, `dates`, `kms` and `gaps`,
  where gaps are drives the traveller arranges themselves (`plan.js:1386-1397`).
- **Trip booking.** The booking page's trip estimate sends one leg per non-gap drive
  (`booking.js:1462-1468`). `/bookings/trip` sends `stops`, `nights` and service details, but no
  gaps (`booking.js:2734-2746`). `priceTrip` measures **every** consecutive stop pair with
  `maps.distance()` (`pricing.ts:138-157`). `TripInput` is a plain `z.object`
  (`api/src/domain/trip.ts:13-29`).
- **Storage.** `trip_request` holds arrays for stops, nights and dates (`schema.ts:271-286`), and
  has no km or road field.

### 3.5 After payment, no view carries a road

The ops list and sheet use `route()`, which prints `from → to` or joins trip stops
(`api/src/services/opsView.ts:62-72`). The ops sheet's trip rows come from `legsHtmlFor`
(`ops-ui.html:3425-3440`). Customer emails and the ops "Paid:" email use `journey()` and
`routeText()` (`api/src/services/notifications.ts:74-95, 190`). There is no driver job sheet;
`ride_ops` holds only flags and timestamps (`schema.ts:567-580`). Inferred: ops briefs drivers
off-system, so the ops sheet is the driver hand-off.

**Consequence:** a front-end-only popup would show a local-road fare that the booking then charges
as the expressway, and the driver would never be told. Every layer below has to change.

## 4. Design

### 4.1 API (interface change, own step)

All additions are optional, so every existing caller is unchanged.

1. **Leg field `routeVariant: 'fastest' | 'no_tolls'`** on private legs of
   `POST /quote/v2/estimate`, on any leg of a one- or multi-leg intent.
   - With `'no_tolls'` the server calls `distanceVariants` and prices that leg at `noTolls.km`.
   - When there's no confirmed fork (not material, Google failed, or the endpoints changed), it
     prices that leg's expressway as today and echoes `legs[i].routeVariant: 'fastest'`. That is a
     normal 200, so the caller sees the fallback.
   - Not accepted on chauffeur intents (§4.9).
2. **Intent field `compareRoutes: true`**, allowed only on a one-leg private intent. The server
   prices the request exactly as today, then calls `distanceVariants`. If there's a fork **and**
   the local road prices lower for this vehicle, the response gains (illustrative figures):

   ```json
   "routeChoice": {
     "fastest": { "distanceKm": 335, "durationMin": 300, "totalCents": 14000 },
     "noTolls": { "distanceKm": 245, "durationMin": 405, "totalCents": 9900 }
   }
   ```

   The second price is a second engine run with no extra Google call. `fastest` repeats the main
   result, so the offer shows exactly what the card charges.
3. **`POST /quote/v2/estimate-batch` accepts `compareRoutes` per intent** and returns
   `routeChoice` beside `totalCents` for each result. The batch keeps its catalogue-towns-only rule
   (`quote.ts:309-345`), so it can't fan arbitrary addresses out to Google. The plan page uses it
   to check every drive in one request (§4.7).

Rules:

- **Cheaper, not just different.** The ops fork test uses an absolute km gap (`Math.abs`,
  `maps.ts:30`), so it would also flag a toll-free road that is longer *and* slower. The customer
  offer requires `noTolls.totalCents < fastest.totalCents`. Short trips on the vehicle floor fare
  price the same both ways and are never offered.
- **Never price on the offline fallback.** `distanceVariants().fastest` falls back to
  `offlineEstimate`, which doesn't set `estimated: true` (`maps.ts:206-212, 313`). The main price
  keeps using `maps.distance()`, which does flag it. Only `noTolls` is taken from
  `distanceVariants`, and it exists only when both Google answers succeeded (`maps.ts:315-317`).
- Hot zones and price finishing apply unchanged. Zones match stop names, and finishing runs on the
  subtotal (`api/src/quote/engine.ts:127-128`). There is no rate card change.
- The per-IP limit (20 POSTs a minute on `/quote/*`, `api/src/config.ts:60-61`) is unaffected.
  Search still makes two requests, the plan page adds one batch per change of drives, and a road
  switch makes none.

### 4.2 Booking API carries and stores the road

- **Single transfer.** `SingleTransferInput` gains optional `routeVariant`. With `'no_tolls'`,
  `priceSingle` measures via `distanceVariants` and prices at `noTolls.km`. The distance enrichment
  (`bookings.ts:486-491`) stores that road's km and time.
- **Trip.** `TripInput` gains optional `routeVariants`: one entry per consecutive stop pair
  (`null`, `'fastest'` or `'no_tolls'`), and its length must be `stops.length − 1`. `priceTrip`
  measures each `'no_tolls'` pair via `distanceVariants`. It's accepted only with
  `serviceType: 'private'`.
- **The booking never silently switches road.** If any requested local road can't be confirmed,
  the booking returns 422 `route_choice_unavailable` and charges nothing. The estimate falls back
  gracefully (§4.1); the booking doesn't.
- **One migration, two nullable columns:** `transfer_request.route_variant text` and
  `trip_request.route_variants text[]`. The array matches the table's existing arrays for nights
  and dates. Null means the customer never chose, which prices as the expressway. It's
  hand-written, with the next free number at build time (`0058` is the latest on main). Per
  `CLAUDE.md`, it applies to staging the moment it merges and to prod on the promote, so it needs
  the owner's OK (§8).

Why columns rather than `bookings.pricing_snapshot_json`: every view that shows a trip reads
`booking.input` (§3.5). The snapshot is documented as immutable pricing evidence, read back only
for add-ons. `booking_legs` has one row per drive but is documented as pricing nothing, and no view
reads it.

### 4.3 Who sees the road after payment

Shown only for drives on the local road:

| Where | Change |
|---|---|
| Ops booking sheet: the single "Route" row (`ops-ui.html:3858`) and the trip rows (`legsHtmlFor`, `:3425-3440`) | "Local road, no expressway" on each such drive. This is the driver hand-off. |
| Ops "Paid:" email body (`api/src/services/opsNotifications.ts` `bookingFacts`) | A "Road" fact naming the local-road drives. **The subject stays unchanged**, because the owner forwards on it. |
| Customer confirmation email (`notifications.ts` `routeRow` / `journey()`) | One line per such drive: "By the local road · about 6h 45m". |

`routeText()` and `route()` stay as they are, so subjects, lists and search text don't move.

### 4.4 Booking page (`booking.js`)

- **Single transfer.**
  - It reads `road=no_tolls` from the search Select link and adds `routeVariant` to the leg.
  - If the estimate echoes `'fastest'`, for example after the customer moves the exact pickup
    spot, the page drops the road and shows one line in the summary: "The local road isn't
    available for these exact points, so this is the expressway fare."
- **Trip.**
  - It reads `roads=` from the plan hand-off, index-aligned with `kms` and `gaps`.
  - Each non-gap estimate leg gets its `routeVariant`, and the `/bookings/trip` body gets
    `routeVariants`. A per-leg echo of `'fastest'` drops that drive's road with the same notice.
- **Summary.** It shows "Via local road" beside `#sum-route-estimate`, or on each drive for a trip.
  That aside is also the phone sheet, so this covers both.
- **Map.** The route map passes `runs` with `avoidTolls: true` for local-road drives
  (`CH_MAP.renderRoute`; `ch-map.js:220-231, 327-333`), so the line drawn is the road priced.
- **Unavailable at booking.** On a 422 `route_choice_unavailable` the page re-prices as the
  expressway and asks the customer to review before paying again.
- **Changing the road** happens on the search or plan page. The booking page only displays it.

### 4.5 Shared popup and card-switch component

Search and plan show the same popup, so it's written once as a small script both pages load, with
its own inline styles. Editing `site.css` would re-stamp 68 pages.

- **Content.** It follows the mockup, with two option cards:
  - **Expressway**, tagged "Fastest": time as the headline, then price, km, "tolls included", and
    "Best for a flight or a tight schedule".
  - **Local road**, tagged "Save $X": price as the headline, then time with "+1h 45m", km, and
    "no tolls". Its best-for line is route-neutral, "Best if you'd rather pay less", because not
    every fork is hill country.
- **Buttons.** The expressway is pre-selected, as in ops. The buttons are "Decide later", which
  keeps the expressway and stores nothing, and "Use local road" / "Use expressway". Close, Escape
  and a click on the scrim all mean "Decide later".
- **No map in v1.** The mockup's map sketch was illustrative. A real map needs two billed
  `computeRoutes` calls and can wait up to 12 s (`ch-map.js:98, 351, 386-388`). `ch-map.js` also
  forbids a modal inside a modal (`:311`). A static drawing would misrepresent the roads.
- **Phone.** A bottom sheet with a slide-up, scrim and scroll lock, modelled on the booking page's
  sheet (`booking.js:3097-3106`, CSS at `booking.html:655-700`). Motion is off under
  `prefers-reduced-motion`.
- **Accessibility.** `role="dialog"`, `aria-modal`, labelled by its title, with the two cards as a
  native radio group. Focus goes to the selected card and returns on close. Modelled on
  `openExpanded` in `ch-map.js:249-315`, which has no focus trap on purpose.
- **Layering.** The z-index sits above the sticky header (70) and below the place menu (1000).
- **Once.** It opens at most once per pair per tab session, tracked in sessionStorage by
  from → to. It never stacks: while one is open, other offers wait as a switch or chip.

### 4.6 Search page (`search.js`)

**When it opens.** It opens after the engine fares land and both the car and van responses carry
`routeChoice`, via `showFares()` for a catalogue pair or the priced render for an engine-only
route. It doesn't open when:

- the catalogue fallback answered, so there's no engine data;
- `QUOTE_V2_ENABLED` is off;
- the pair was already asked this tab session, or the URL already carries `road` (for example, the
  customer came back from booking);
- the page is hidden, or focus is inside the edit-search form;
- the customer has already clicked a Select link.

**After a pick.** The private card gains a two-option switch, "Expressway · 5h" and "Local road ·
6h 45m", with both prices already on hand, so switching makes no request.

- Choosing the local road updates the car and van prices, the meta line ("Approx. 245 km · 6h 45m
  · via local road"), and the Select links, which gain `road=no_tolls` and the local road's
  `estimateKm`/`estimateMin`.
- **An explicit exception to "a fare once shown never changes"** (`search.js:719`). That rule
  exists so a late answer can't move a price under the cursor. Here the customer changed the
  product and has already seen both prices. The rule still holds for late answers.
- The shared-seat and ride-board savings are recomputed against the fare the card now shows.
  Otherwise the page would state a saving against a price it no longer offers.
- A switch re-renders only the private card. `showFares()` must not run again, because it calls
  `trackResults()` and would fire `search` / `view_item_list` twice (`search.js:701-707`).
- "Add stops to this trip" still hands only the stops to the plan page (`search.js:247-255`). The
  plan page re-checks each new drive itself, because an added stop changes the roads.

### 4.7 Plan page (`plan.js`)

**Checking drives.** After the drives change (debounced, like the rest of the page), `plan.js`
sends one `estimate-batch` request. It holds one one-leg car intent with `compareRoutes: true` per
priced drive. Gap drives and drives with a Google-picked place are skipped; the batch prices only
catalogue towns (§4.1). One request per change keeps the plan page inside the rate limit however
many drives there are. Today the plan page makes no pricing calls at all, so this is its first.

**What a forked drive shows.**
- The drive card (`distHtml`, `plan.js:519-533`) gains a chip: "Cheaper local road · save about
  $X".
- After a pick the chip becomes "Road: Local road ▾" or "Road: Expressway ▾", and it reopens the
  popup, as the ops chip does.

**Plan-page prices stay the plan page's own.** The plan page shows guide prices from its own
`legPrice(km)` (`plan.js:148`), and the booking page re-prices every drive through the engine
anyway. So the popup and the card show plan-page prices for both roads, computed from the two
distances and labelled "about". The engine's `routeChoice` decides only whether a cheaper fork
exists and what its km and time are. This keeps every figure on the page on one method.

**Auto-open, once per drive.**
- It opens for a drive when that drive's answer lands and the page is quiet: no text field
  focused, no place menu open, no other popup open.
- If the page isn't quiet, it opens at the next quiet moment (a blur that leaves no field
  focused), or not at all if another popup is open by then.
- Each drive is asked at most once per tab session, and several forks never chain. Only the
  earliest undecided drive in trip order auto-opens; the rest keep their chip.

**Edits re-arm.** Changing a drive's endpoints, including adding or removing a stop that splits or
merges it, clears that drive's road and its "asked" mark. Drives the edit didn't touch keep their
choice.

**Other changes.**
- `goToBooking` adds `roads=`, index-aligned with the drives. `kms` carries the local road's km
  for local-road drives, so the booking page's first-paint total matches.
- The trip map passes `runs` with `avoidTolls` per drive. `routeRuns` hard-codes `false` today
  (`plan.js:1055`), and `runs` is passed only when a trip has gaps (`:1033-1037`).
- The guide total uses the local-road price for local-road drives.

### 4.8 Sightseeing (owner question, 2026-09-27)

- **The booking page's "Add sightseeing stops" extra works unchanged.** It's a flat $10 for "up to
  3 hours of stops along the way", records no places, and doesn't change the distance
  (`booking.html:920`, `rateCard.ts:65`). The price is the chosen road's fare plus $10, and the
  stops happen along that road.
  - The ops sheet shows both the road and "Sightseeing stops", so the driver plans stops on the
    right road.
  - The popup's times exclude stop time on both roads, so they stay comparable.
  - This extra is offered only on single transfers; trips hide it (`booking.js:2048-2050`).
- **A sightseeing stop added on the plan page is a real stop.** It splits one drive into two
  (§3.4), and each new drive is checked for its own fork (§4.7). A local road chosen for
  Colombo Airport → Ella doesn't carry over to Colombo Airport → Kitulgala and Kitulgala → Ella.
  The stop decides the road, and each part is offered separately.

### 4.9 Analytics

New event `route_choice` with `{ choice: 'fastest' | 'no_tolls' | 'dismissed', source: 'popup' |
'card', page: 'search' | 'plan', saving_usd }`. New events don't pass through on their own. The
build has to:

1. register the event in `tools/analytics/build-gtm-missing-tags.mjs`;
2. regenerate `docs/analytics/gtm-missing-tags.json`, which `web-tests/unit/gtm-event-coverage.test.js`
   enforces.

The owner then imports the tags into GTM (`docs/analytics/gtm-container-checklist.md`).

### 4.10 Chauffeur service is excluded

Chauffeur trips are priced by day and per-day km (`booking.js:1449-1461`; the chauffeur intent
has no legs). If a customer picks local roads on the plan page and then chooses the chauffeur
service on the booking page, the roads are dropped with a one-line notice. Carrying a road into
chauffeur pricing is a separate change.

## 5. Build steps (one PR each, in order)

0. **Spike, owner-approved, nothing committed.** Run `distanceVariants` for the 20 most-searched
   pairs, or the top catalogue pairs if search data isn't to hand, and count real, cheaper forks.
   This uses the real Google key, about 40 elements. If almost nothing forks, stop and re-decide
   before building.
1. **API:** §4.1, with vitest coverage.
2. **Booking API + migration:** §4.2 and §4.3. Needs the owner's OK before merge.
3. **Booking page:** §4.4, single transfers and trips.
4. **Popup component + search page:** §4.5, §4.6 and §4.9.
5. **Plan page:** §4.7.

The customer-facing steps land last, so no page offers a road the booking can't honour. Pages and
the API both deploy from `production`, so everything ships together on one promote. Steps 4 and 5
may ship on separate promotes if the owner wants search first.

## 6. Testing

- **API (vitest), step 1:**
  - `routeVariant` is accepted on one- and multi-leg private intents and rejected on chauffeur.
  - `compareRoutes` is accepted on a one-leg intent and rejected on two or more.
  - `no_tolls` prices at the toll-free km; the client can't send km.
  - No fork, or a Google failure, echoes `fastest` for that leg only.
  - `routeChoice` appears only when the local road is cheaper; a floor-fare pair has none.
  - The offline fallback is never priced.
  - The batch returns `routeChoice` per intent and still skips non-catalogue legs.
- **API (vitest), step 2:**
  - Single and trip bookings price and persist the road.
  - `routeVariants` length is validated, and chauffeur trips reject it.
  - A booking returns 422 when a fork is gone.
  - The migration round-trips. The DB suites need `DATABASE_URL_TEST` locally, or they skip.
  - The ops sheet, "Paid:" email body and confirmation email show the road; the subject is
    byte-identical.
- **web-tests e2e (Playwright), search** (estimates stubbed via `installEstimateStub`):
  - The popup opens once on a fork, and not without one.
  - It doesn't open on the catalogue fallback, or on a reload in the same tab session.
  - Picking the local road re-prices the card, and Select carries `road=no_tolls`.
  - "Decide later" keeps the expressway; Escape and the scrim close the popup.
  - The phone sheet renders at 375 px.
- **Plan** (batch stubbed):
  - One batch per change; gap and Google-picked drives are left out of it.
  - A forked drive shows its chip.
  - Auto-open fires once, only when the page is quiet, and never chains to a second drive.
  - Adding a stop re-arms only the drives it changed.
  - `roads=` reaches booking.
- **Booking:**
  - `road` and `roads` reach the estimate and the booking body.
  - The per-leg echo fallback shows the notice.
  - Choosing chauffeur drops the roads.
  - The sightseeing extra adds $10 on a local-road single transfer.
- **Gates:** `cd api && npm run check`, then `npm --prefix web-tests run test:all`, which includes
  Playwright. Test dates come from `web-tests/dates.js`.

## 7. Cost

Each comparison costs two Google Distance Matrix elements for a pair not seen in the last 24 h, on
that process. Today a catalogue pair costs nothing after its first lookup, because `distance()` is
cached in Postgres with no expiry. The comparison cache lives in memory, so a deploy or restart
empties it.

- A search checks one pair.
- A plan batch checks each catalogue drive, up to 10, so about 20 elements on a cold plan.
- Repeat edits hit the cache.

At current traffic this is small. Moving the comparison into the Postgres cache is a possible
follow-up, and not part of this spec.

## 8. Needs the owner

1. **Spike go-ahead** (step 0): real Google calls, about 40 elements.
2. **Migration OK:** two nullable columns, released to staging on merge.
3. **Copy sign-off:** popup title, card lines, the plan chip, the booking notice, and the email
   line.
4. **GTM import** of the `route_choice` tags after step 4.

## 9. Out of scope

- **Google-picked places on the plan page:** the batch prices catalogue towns only. Those drives
  keep today's single price.
- Chauffeur pricing on a chosen road (§4.10), the shared van, and the ride board.
- The generated `/trip/*` pages and their baked prices.
- A map in the popup, showing the road on `manage.html`, and toll pricing.
- **Adjacent, not fixed here. Each is raised with the owner separately.**
  - **An ops quote's road is dropped when it converts to a booking**
    (`api/src/quote/quoteToBooking.ts:103-118`). The new columns would make it easy to carry
    later.
  - **Trip bookings appear to charge for self-arranged gap drives.** `/bookings/trip` sends every
    stop without the gaps (`booking.js:2734-2746`), and `priceTrip` prices every consecutive pair
    (`pricing.ts:144-157`). This is inferred from the code and not yet reproduced.
  - **Leg-count mismatch.** The v2 estimate caps private intents at 8 legs (`webQuoteV2.ts:34`),
    while a plan can hold 10 drives and a trip up to 11 legs (`trip.ts:11`). This is an existing
    issue. The plan batch sends one-leg intents, so it doesn't hit the cap.
