# Search page route choice — expressway or local road

**Date:** 2026-09-26 · **Status:** spec written for owner review; nothing built · **Read from:**
`origin/main` @ `59cb7158`. This is "Phase 2" of route choice, which the ops spec deferred
(`docs/superpowers/specs/2026-07-21-ops-route-choice-modal-design.md`, "Out of scope").

## 1. Problem

The ops quote tool offers a choice when a trip has a materially cheaper toll-free road. It
auto-opens a popup once per leg (`api/src/routes/ops-ui.html:11055-11064`, guard
`shouldPromptRouteChoice` at `:11075-11088`). The customer search page never does. A traveller
searching Colombo Airport → Ella sees only the expressway fare, even when a slower local road
would cost them less.

## 2. Owner decisions (2026-09-26, chat)

1. Replicate the ops popup on `search.html`. The owner reviewed a mockup in chat: a desktop popup,
   a phone bottom sheet, and a private-transfer card that keeps a road switch after the pick.
2. **Auto-open once.** The card's switch stays so the customer can change their mind.

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

### 3.3 The customer path can't carry a road today

- **Estimate.** `POST /quote/v2/estimate` legs are `{ from, to }` with `.strict()`
  (`api/src/quote/webQuoteV2.ts:24-34`), so any extra key is a 400. The server measures each leg
  with `maps.distance()`, the fastest road only (`api/src/routes/quote.ts:68-75`). No public
  endpoint calls `distanceVariants` (the only caller is the ops `/admin/quote/distance`,
  `internalQuote.ts:795`).
- **Booking.** `booking.js` posts `/bookings/single` with `from`/`to`, and the server re-prices
  with `maps.distance()` (`api/src/services/pricing.ts:72-99`, called at
  `api/src/routes/bookings.ts:478`). `SingleTransferInput` is a plain `z.object`
  (`api/src/domain/singleTransfer.ts:82-97`), so an extra `routeVariant` key would be silently
  stripped. The rate lock (`POST /quote/lock`) freezes only the rate card; the booking still
  measures the road itself (`bookings.ts:344-356, 475-478`).
- **Storage.** A single transfer is stored in typed columns on `transfer_request`
  (`api/src/db/schema.ts:98-115`). There is no road column and no JSON catch-all.
- **After payment.** No human-facing view carries a road. The ops list and sheet use `route()`,
  which prints `from → to` (`api/src/services/opsView.ts:62-72`). Customer emails and the ops
  "Paid:" email use `routeText()` (`api/src/services/notifications.ts:190`). There is no driver
  job sheet in the system; `ride_ops` holds only flags and timestamps (`schema.ts:567-580`).
  Inferred: ops briefs drivers off-system, so the ops sheet is the driver hand-off.

**Consequence:** a front-end-only popup would show a local-road fare the booking then charges as
the expressway, and the driver would never be told. Every layer below has to change.

## 4. Design

### 4.1 API — `POST /quote/v2/estimate` (interface change, own step)

Both additions are optional, so every existing caller is unchanged.

1. **Leg field `routeVariant: 'fastest' | 'no_tolls'`.** Allowed only when the intent has exactly
   one leg, matching the ops two-stop rule (GC-10). With `'no_tolls'` the server calls
   `distanceVariants` and prices at `noTolls.km`. When there's no confirmed fork (not material,
   Google failed, or the endpoints changed), it prices the expressway as today and echoes
   `legs[0].routeVariant: 'fastest'`. That is a normal 200, so the caller sees the fallback.
2. **Intent field `compareRoutes: true`.** Allowed only with one leg. The server prices the
   request exactly as today, then calls `distanceVariants`. If there's a fork **and** the local
   road prices lower for this vehicle, the response gains (illustrative figures):

   ```json
   "routeChoice": {
     "fastest": { "distanceKm": 335, "durationMin": 300, "totalCents": 14000 },
     "noTolls": { "distanceKm": 245, "durationMin": 405, "totalCents": 9900 }
   }
   ```

   The second price is a second engine run with no extra Google call. `fastest` repeats the main
   result, so the popup shows exactly what the card charges.

Rules:

- **Cheaper, not just different.** The ops fork test uses an absolute km gap
  (`Math.abs`, `maps.ts:30`), so it would also flag a toll-free road that is longer *and* slower.
  The customer offer requires `noTolls.totalCents < fastest.totalCents`. Short trips sitting on the
  vehicle floor fare price the same both ways and are never offered.
- **Never price on the offline fallback.** `distanceVariants().fastest` falls back to
  `offlineEstimate`, which doesn't set `estimated: true` (`maps.ts:206-212, 313`). The main price
  keeps using `maps.distance()`, which does flag it. Only `noTolls` is taken from
  `distanceVariants`, and it exists only when both Google answers succeeded (`maps.ts:315-317`).
- Hot zones and price finishing apply unchanged: zones match stop names, finishing runs on the
  subtotal (`api/src/quote/engine.ts:127-128`). No rate card change.
- The per-IP limit (20 POSTs a minute on `/quote/*`, `api/src/config.ts:60-61`) is unaffected. The
  search page still makes two requests, one per vehicle, and a road switch makes none.

### 4.2 Booking — `/bookings/single` carries and stores the road

- `SingleTransferInput` gains optional `routeVariant: 'fastest' | 'no_tolls'`.
- `priceSingle` with `'no_tolls'` measures via `distanceVariants` and prices at `noTolls.km`. If
  the fork can't be confirmed it returns 422 `route_choice_unavailable` and charges nothing.
  Unlike the estimate, the booking never silently switches to a dearer road.
- The best-effort distance enrichment (`bookings.ts:486-491`) stores the local road's km and time.
- **Migration: add nullable `route_variant text` to `transfer_request`.** Null means the customer
  never chose, which prices as the expressway. Hand-written, next free number at build time
  (`0058` is the latest on main). Per `CLAUDE.md`, it applies to staging the moment it merges and
  to prod on the promote, so it needs the owner's OK (§8).

Why a column rather than `bookings.pricing_snapshot_json`: every view that shows a trip reads
`booking.input` (§3.3), and the snapshot is documented as immutable pricing evidence, read back
only for add-ons. A column puts the road where those views already look.

### 4.3 Who sees the road after payment

Shown only when the road is `no_tolls`:

| Where | Change |
|---|---|
| Ops booking sheet (`ops-ui.html` `renderSheet`, "Route" row at `:3858`) | New "Road" row: "Local road, no expressway · 245 km · 6h 45m". This is the driver hand-off. |
| Ops "Paid:" email body (`api/src/services/opsNotifications.ts` `bookingFacts`) | Same fact line. **The subject stays unchanged**, because the owner forwards on it. |
| Customer confirmation email (`notifications.ts` `routeRow`) | One line under the route: "By the local road · about 6h 45m". |

`routeText()` and `route()` stay as they are, so subjects, lists and search text don't move.

### 4.4 Booking page (`booking.js`)

- Reads `road=no_tolls` from the Select link. It is honoured only for a private single transfer.
- `buildEstimateIntent()` adds `routeVariant` to the leg. If the estimate echoes `'fastest'`
  (for example after the customer moves the exact pickup spot), the page drops the road and shows
  one line in the summary: "The local road isn't available for these exact points, so this is the
  expressway fare."
- The summary shows "Via local road · no expressway" beside `#sum-route-estimate`. That aside is
  also the phone sheet, so one line covers both.
- The route map passes `runs: [{ stops, avoidTolls: true }]` to `CH_MAP.renderRoute`, so the line
  drawn is the road priced. `ch-map.js` already supports this (`ch-map.js:220-231, 327-333`).
- The `/bookings/single` body gains `routeVariant`. On a 422 `route_choice_unavailable` the page
  re-prices as the expressway and asks the customer to review before paying again.
- Changing the road happens on the search page. The booking page only displays it.

### 4.5 Search page (`search.js`)

**When it opens.** It opens after the engine fares land and both the car and van responses carry
`routeChoice`, via `showFares()` for a catalogue pair or the priced render for an engine-only
route. It doesn't open when:

- the catalogue fallback answered, so there's no engine data;
- `QUOTE_V2_ENABLED` is off;
- this pair has already been asked this tab session (sessionStorage key per from→to);
- the URL already carries `road`, for example the customer came back from booking;
- the page is hidden, or focus is inside the edit-search form;
- the customer has already clicked a Select link.

**The popup.** It follows the mockup with two option cards:

- **Expressway**, tagged "Fastest": time as the headline, then car price, km, "tolls included",
  van price, and "Best for a flight or a tight schedule".
- **Local road**, tagged "Save $X" (the car saving): price as the headline, then time with
  "+1h 45m", km, "no tolls", and van price. Its best-for line is route-neutral, "Best if you'd
  rather pay less", because not every fork is hill country.

The expressway is pre-selected, as in ops. The buttons are "Decide later", which keeps the
expressway and stores nothing, and "Use local road" / "Use expressway". Close, Escape and a
click on the scrim all mean "Decide later".

- **No map in v1.** The mockup's map sketch was illustrative. A real map needs two billed
  `computeRoutes` calls and can wait up to 12 s (`ch-map.js:98, 351, 386-388`). `ch-map.js` also
  forbids a modal inside a modal (`:311`). A static drawing would misrepresent the roads.
- **Phone.** A bottom sheet with a slide-up, scrim and scroll lock, modelled on the booking
  page's sheet (`booking.js:3097-3106`, CSS at `booking.html:655-700`). Motion is off under
  `prefers-reduced-motion`.
- **Accessibility.** `role="dialog"`, `aria-modal`, labelled by its title, and the two cards as a
  native radio group. Focus goes to the selected card and returns on close. Modelled on
  `openExpanded` in `ch-map.js:249-315`, which has no focus trap on purpose.
- **Styles** go in `search.html`'s inline `<style>`. Editing `site.css` would re-stamp 68 pages.
  The z-index sits above the sticky header (70) and below the place menu (1000).

**After a pick.** The private card gains a two-option switch, "Expressway · 5h" and "Local road ·
6h 45m", with both prices already on hand, so switching makes no request.

- Picking or switching to the local road updates the car and van prices, the meta line ("Approx.
  245 km · 6h 45m · via local road"), and the Select links, which gain `road=no_tolls` and the
  local road's `estimateKm`/`estimateMin`.
- **An explicit exception to "a fare once shown never changes"** (`search.js:719`). That rule
  exists so a late answer can't move a price under the cursor. Here the customer changed the
  product and has already seen both prices. The rule still holds for late answers.
- The shared-seat and ride-board savings are recomputed against the fare the card now shows.
  Otherwise the page would state a saving against a price it no longer offers.
- A switch re-renders only the private card. `showFares()` must not run again, because it calls
  `trackResults()` and would fire `search` / `view_item_list` twice (`search.js:701-707`).

### 4.6 Analytics

New event `route_choice` with `{ choice: 'fastest' | 'no_tolls' | 'dismissed', source: 'popup' |
'card', saving_usd }`. The ops Phase 1 plan made conversion data the justification for this phase
(`docs/superpowers/plans/2026-07-20-route-choice-ops-quote.md:270`). New events don't pass
through on their own. The build has to:

1. register the event in `tools/analytics/build-gtm-missing-tags.mjs`;
2. regenerate `docs/analytics/gtm-missing-tags.json`, which `web-tests/unit/gtm-event-coverage.test.js`
   enforces.

The owner then imports the tags into GTM (`docs/analytics/gtm-container-checklist.md`).

## 5. Build steps (one PR each, in order)

0. **Spike, owner-approved, nothing committed.** Run `distanceVariants` for the 20 most-searched
   pairs and count real, cheaper forks. This uses the real Google key, about 40 elements. If
   almost nothing forks, stop and re-decide before building.
1. **API:** §4.1, with vitest coverage.
2. **Booking + migration:** §4.2 and §4.3. Needs the owner's OK before merge.
3. **Booking page:** §4.4.
4. **Search page:** §4.5 and §4.6.

The search step lands last, so the site never offers a road the booking can't honour. Pages and
the API both deploy from `production`, so all four ship together on one promote.

## 6. Testing

- **API (vitest), step 1:**
  - The schema accepts the new fields on one leg and rejects them on two or more.
  - `no_tolls` prices at the toll-free km; the client can't send km.
  - No fork, or a Google failure, echoes `fastest`.
  - `routeChoice` appears only when the local road is cheaper; a floor-fare pair has none.
  - The offline fallback is never priced.
- **API (vitest), step 2:**
  - The booking prices and persists `no_tolls` and returns 422 when the fork is gone.
  - The migration round-trips. The DB suites need `DATABASE_URL_TEST` locally, or they skip.
  - The ops sheet, "Paid:" email body and confirmation email show the road; the subject is
    byte-identical.
- **web-tests e2e (Playwright), with estimates stubbed via `installEstimateStub`:**
  - The popup opens once on a fork, and not without one.
  - It doesn't open on the catalogue fallback, or on a reload in the same tab session.
  - Picking the local road re-prices the card, and Select carries `road=no_tolls`.
  - "Decide later" keeps the expressway; Escape and the scrim close the popup.
  - The phone sheet renders at 375 px.
  - Booking with `road` shows the summary line and sends `routeVariant`; the echo fallback shows
    the notice.
- **Gates:** `cd api && npm run check`, then `npm --prefix web-tests run test:all`, which
  includes Playwright. Test dates come from `web-tests/dates.js`.

## 7. Cost

Every search of a pair not seen in the last 24 h costs two Google Distance Matrix elements for the
comparison. Today a catalogue pair costs nothing after its first lookup, because `distance()` is
cached in Postgres with no expiry. The comparison cache lives in memory, so a deploy or restart
empties it. At current traffic this is small. Moving the comparison into the Postgres cache is a
possible follow-up, and not part of this spec.

## 8. Needs the owner

1. **Spike go-ahead** (step 0): real Google calls, about 40 elements.
2. **Migration OK:** `transfer_request.route_variant`, released to staging on merge.
3. **Copy sign-off:** popup title, card lines, the booking notice, and the email line.
4. **GTM import** of the `route_choice` tags after step 4.

## 9. Out of scope

- Multi-stop trips, `plan.html`, the shared van and the ride board.
- The generated `/trip/*` pages and their baked prices.
- A map in the popup; showing the road on `manage.html`; toll pricing.
- **Adjacent, not fixed here:** an ops quote's road is dropped when it converts to a booking
  (`api/src/quote/quoteToBooking.ts:103-118`). The new column would make that easy to carry
  later.
