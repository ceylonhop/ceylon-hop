# Customer place identity: price and drive the place the customer picked

**Date:** 2026-10-18
**Status:** draft for owner review
**Extends:** `2026-08-02-positive-location-identification-design.md` (ops quote tool only, Stage 1 shipped in #283/#286, Stage 2 never shipped)
**Related:** `2026-08-08-post-payment-trip-details-design.md` (booking_legs Phase 2, which reserved the coordinate columns this spec writes)
**Code read at:** `origin/main` `edf36f0b` and `origin/production` `4cc76343` (the files this spec touches are identical on both, except `postgresBookingRepo.ts`, which main extends)

---

## 1. The incident

Three trip bookings were saved unpriced and could not be paid. All three are still drafts, and all three ops follow-up tasks are still open:

| Booking | Created | Leg that failed | Placeholder |
|---|---|---|---|
| CH-YHK98 | 2026-09-15 | ALAIA by The Hotel → **The Find** | $400 |
| CH-FHYQT | 2026-10-15 | EKHO Sigiriya → **Casa Selvita** | $200 |
| CH-E7EE8 | 2026-10-18 | same trip, same customer, second attempt | $200 |

The customer picked "Casa Selvita" from Google's dropdown in the planner. They then saw a price and a pay button, filled in every detail, and at the very last click got *"We're confirming the price for this trip by hand"* (the 409 `awaiting_price` from `bookings.ts:1035`).

## 2. Root cause (verified)

1. **The picker throws the identity away.** `ch-map.js:660` `resolvePick` fetches the picked place's location and address. `plan.js:326-328` then overwrites the field with `geo.name`, the short main text, and keeps nothing else. `booking.js:493-511` (the exact-spot fields) does the same for the API. It keeps `{name,address,lat,lng}` in `state.locFromGeo`, but only for the map and the radius guard. **No page sends a place ID or coordinates to the API** (front-end inventory, 2026-10-18).
2. **The server re-guesses from text.** `googleDistance` (`maps.ts:326`) sends the bare name to Distance Matrix. Live, 2026-10-18:
   - `"Casa Selvita"` and `"The Find"` return `quote_unpriced` against any other place.
   - `"Casa Selvita, Sri Lanka"` prices at 87 km.
   - Appending text is not a fix. `"The Find, Sri Lanka"` prices at 3 km and `"Casa Selvita Sigiriya"` at 1 km: confident answers that may be the wrong place.
3. **The page sells a price the server will refuse.** `ch-pricing.js` turns the estimate's 422 `quote_unpriced` into `onUnavailable('http_error')`, the same signal as a network blip. `calcTotal()` (`booking.js:2054`) then falls back to the local formula, and the pay button stays live.
4. **Nobody hears about it.** `flagForOps` (`bookings.ts:420`) only inserts a `concierge_tasks` row, so these sat for up to a month.

This has been possible since 2026-07-07 (`4c4fe859`, layered Google search in the planner) and 2026-07-25 (#151, checkout refuses unpriced bookings).

**Same family:** the "Airport, Sri Lanka" wrong-airport price (2026-09-22) and Q-CEVGM's "Yala, Sri Lanka" at 78 km (2026-08-02) are the same disease in the other direction: text re-geocoded to a confident wrong place.

## 3. Goals

- G1. A place the customer picked from Google is priced, and driven to, as **that exact place**.
- G2. The page never shows a pay button for a price the server will refuse.
- G3. An unpriced booking reaches a human the same day.
- G4. The booking keeps the resolved place, so ops and the driver get an exact pin, frozen at booking time.
- G5. **Nothing that exists today changes meaning.** No past booking, quote, email, pay link, manage page, analytics row or advertised price is altered or re-measured.

## 4. Non-goals (v1)

- Changing the ops quote tool. It has its own resolver (August spec), and its Stage 2 stays a separate decision.
- Refusing to price free text. The legacy text path stays as the last fallback; retiring it is a later, data-gated decision (§13).
- Re-pricing, re-geocoding or backfilling any existing booking or quote.
- Changing how a place name is displayed or stored. The stored string stays exactly what it is today.
- Shared seats and the ride board. They are corridor/catalogue based and have no Google path.

## 5. The model

A place has two halves. The **name** is what people read; the **identity** is what we measure and drive to.

| Field | Example | Where it lives | Who reads it |
|---|---|---|---|
| Display name | `Casa Selvita` | Unchanged everywhere it lives today: `trip_request.stops`, `transfer_request.*_place`, `booking_legs.*_place`, `Booking.input` | Customer, emails, ops, analytics, duplicate matcher |
| Place ID | Google's ID | Browser → API (new optional field); `booking_legs.from_place_id`/`to_place_id` (new) | Server pricing; ops "open in Maps" |
| Coordinates | 7.29, 80.63 | **Resolved by the server from the place ID, never taken from the browser.** Held in memory to measure. Written to `booking_legs.from_lat/_lng/to_lat/_lng` (existing, unused columns) only for catalogue towns, and for Google places only if owner decision O1 allows (§12) | Distance measurement, driver pin |
| Google's own name + address + area | `Casa Selvita, 12 …, Kandy` | Server response; ops view | Ops: what was actually priced; the label-mismatch check |

### 5.1 Why a place ID, not coordinates, crosses the wire

| Browser sends | Problem |
|---|---|
| Name (today) | Ambiguous; the server guesses: no price, or a wrong place |
| Full address text | Better, but still text the server re-guesses |
| Coordinates | Customer-controlled: edit the URL and a 200 km trip becomes 3 km. Breaks the rule that the intent carries names and distances come back from the server (`booking.js:1730`) |
| **Place ID** | Opaque and Google-issued; the server resolves it itself |

**Tampering is harmless by construction.** Pricing and driving use the same identity. Someone who swaps in a nearby place ID gets driven to that nearby place, so the price matches the trip. Ops still sees Google's name for the place ID, flagged when it differs from the label (§8.4).

**IDs rot; coordinates don't.** The August spec chose to store coordinates for this reason (Google says IDs can change and should be refreshed after 12 months). This spec agrees: a place ID is a **transport token at pick time**. The server turns it into coordinates immediately and measures with them.

The booking freezes the **place ID** (storable indefinitely, verified), plus the coordinates where owner decision O1 allows (§12). An ID that later rots doesn't change the trip: the price was fixed at booking time. Ops would then re-pin the place by hand, as they would for any changed address.

## 6. Server resolution order (one function, every public path)

`identifyStop(name, placeId?)` returns the string to measure with, plus the identity to keep:

1. **Catalogue town** (`knownCoords(name)` hits `COORDS`): measure with the **name, exactly as today**. This keeps `distance_cache`, the advertised catalogue fares and the route pages byte-identical.
2. **Place ID present and well-formed:** resolve it server-side to `lat,lng` (Geocoding `place_id=`, §7). Measure with `"lat,lng"`, which `knownCoords`/`parseLatLng` already pin and floor-guard (`maps.ts:179-204`).
3. **Name matches a trusted `place_resolutions` row** (catalog, confirmed or auto_linked, keyed by `canonPlace`): measure with its `lat,lng`. **Read-only:** `repo.get(canonKey)` only, **never** `PlaceResolver.resolve()`. That would let public traffic geocode freely and write `auto_linked` rows into the trusted table.
4. **Otherwise:** measure with the name, exactly as today (the legacy text path).

**Fallbacks never make anything worse than today.** If step 2's lookup fails (outage, `NOT_FOUND`, `INVALID_REQUEST`), the stop falls through to 3, then 4. A request that prices today still prices, unless the new identity proves the old text answer wrong (§10, E9).

**The engine still receives names.** `measureLeg` is called with the measure strings; the legs handed to `quote()` keep `from`/`to` names. This matters because hot zones match by **name only**: `hotZones.ts:116` calls `matches(stop, undefined, zone)`, and the engine never passes coordinates. Passing `"lat,lng"` into the engine would silently drop zone boosts. With names kept, zone behaviour is unchanged.

**Every public measuring site uses it:**
- `priceSingle`, `priceTrip` (`pricing.ts`)
- `engineRequestFor`, private (`quote.ts:75`) and chauffeur (`quote.ts:101`, which calls `maps.distance` directly)
- the stored-distance loops in `bookings.ts` (single ~:613, trip ~:736)

`/quote/v2/estimate-batch` is catalogue-only (`quote.ts:394`) and needs nothing.

## 7. Resolving a place ID on the server

- **New optional adapter method:** `MapsAdapter.placeById?(placeId): Promise<ResolvedPlace | null>`. It is optional, like `geocode?`, so every existing test stub stays valid. An adapter without it simply skips step 2.
- **Google implementation:** `geocode/json?place_id=<id>&key=…`.
  - **Verified in Google's docs (2026-10-18):** geocoding by place ID exists and returns the standard `results[]` (`geometry.location`, `formatted_address`, `address_components`). Google also says "you can use the same place ID across the Places API … the Maps JavaScript API, the Geocoding API".
  - The Geocoding API is already enabled on the server key and already called by `geocodeAll` (`maps.ts:437`), so no new API needs enabling.
  - *Still to prove live in Task 0:* that a real `Place.id` from our front-end picker resolves through it on our server key.
- **Alternative considered:** Distance Matrix accepts `place_id:<id>` directly ("preferred over addresses or latitude/longitude", per Google's docs). It is not chosen: the floor guard and the ops view need the coordinate anyway, and one code path for "resolved stop = coordinate" keeps the ops tool and the website identical.
- **Risk, noted:** Google's Distance Matrix page says the legacy API can no longer be enabled for **new** projects as of October 2026; existing projects remain supported. We are an existing project. This is not caused by this spec, but worth knowing.
- **Returns** `{ placeId, lat, lng, name, address, area }`; `area` = `administrative_area_level_1`, as `geocodeAll` already reads it.
- **Fake implementation:** `fake:<Catalogue Name>` resolves to the catalogue coordinate, and a small fixed table covers test hotels. Anything else returns `null`.
- **Validation:** an ID matching `^[A-Za-z0-9_-]{10,512}$`. Anything else is ignored, as if absent; it is never a 400 and never sent to Google.
- **Caching:** a per-process LRU (500 entries, 24 h TTL, successes only), the same pattern as `variantsCache` (`maps.ts:305-323`). No database cache table.
- **Plumbing:**
  - `CachedMapsAdapter` and `MeteredMapsAdapter` forward it; the metered counter is `maps.place_by_id`.
  - `memoizeDistance` (`bookings.ts:94`) must forward it, because today it drops the optional methods.
- **Bounds the spend:** at most one lookup per distinct ID per request. The existing caps stay (8 legs on the estimate, 12 stops on a trip).

## 8. Wire format (additive, omitted when absent)

**The rule:** a new field is sent **only when it has a value**. A request with no Google pick is byte-identical to today's. So its idempotency key (`booking.js:3293`), intent signature (`booking.js:1836`), `ch-pricing` sessionStorage key, quote-lock signature and server `fingerprintIntent` (`webQuoteV2.ts:84`) are all unchanged. Every existing payload test (`unit/booking-intent.test.js` and others) passes untouched.

### 8.1 API inputs

| Schema | File | New optional field | Notes |
|---|---|---|---|
| `WebQuoteIntentSchema` private leg | `quote/webQuoteV2.ts:25-34` | `fromPlaceId?`, `toPlaceId?` | **Schema is `.strict()`: an old API answers 400 to these.** See the release order in §11 |
| `WebQuoteIntentSchema` chauffeur day | `webQuoteV2.ts:50-58` | `fromPlaceId?`, `toPlaceId?` | same |
| `TripInput` | `domain/trip.ts:14` | `stopPlaceIds?: string[]` | `''` = no identity for that stop. Length must equal `stops.length`, otherwise the whole field is ignored and logged (`[place] stopPlaceIds length mismatch`), never a 400. Default strip, so an old API ignores it |
| `SingleTransferInput` | `domain/singleTransfer.ts:83` | `fromPlaceId?`, `toPlaceId?` | Default strip |
| `QuoteSchema` (`/quote/lock`) | `routes/quote.ts:39` | none | The lock captures the rate card, not distances |

### 8.2 Estimate refusal (additive body)

`422 { error: 'quote_unpriced' }` gains `unresolved: string[]`: the display names of the failing leg's endpoints that are not catalogue towns (a catalogue town is never the problem). The existing `error` key is unchanged, so old pages still read it the same way. The ops note text (`distance unresolved: A → B`) is also unchanged.

### 8.3 Front-end hand-off

- **Planner → booking URL:** a new param `pids`, comma-joined and index-aligned with `stops`, with empty slots for no identity. It is written by `goToBooking` and `syncPlanUrl` (`plan.js:537-550`, `:1633-1656`), and read back by `booking.js` (~:184) and `buildTripEditUrl` (`booking.js:101-107`). Old links have no `pids` and behave exactly as today.
- **Planner state is keyed by the committed string, not threaded per leg.** A page-level `pickedPlaces` map goes from `norm(displayName)` to `{ placeId, address, area }`, written on a Google pick.
  - Every path that copies a stop string (chaining, swap, reorder, templates, edit round-trip) then carries the identity for free. This is the same reasoning the August spec used to key by string.
  - Typing anything else simply doesn't match.
  - `pids` is derived from `seq` at hand-off time.
- **Booking exact-spot fields:** `state.locFromGeo/locToGeo` already exist. They gain `placeId`, and single-transfer estimate and booking bodies send `fromPlaceId`/`toPlaceId` when the field's current text still equals the picked name. Any edit already nulls the geo (`booking.js:589`).
- **Index hero / search (`site.js`):** keeps today's behaviour, because it already sends Google's **full** prediction text, which resolves far better. It is carried through as a later, optional step (Task 9).

### 8.4 What the customer sees

- The same short name as today.
- **New:** a small area line ("· Kandy", Google's `secondaryText`) next to a Google-picked stop on the planner and the booking summary, so a wrong pick is caught by the customer, not the driver. It is display-only and never stored into the name.

### 8.5 Safeguard S2: flag a label that doesn't match its place, at booking time

When a booking is created with a stop priced by place ID (step 2), the server compares the display label with Google's address for that ID. If none of the label's distinctive words appear in the address, it raises an ops follow-up task (`flagForOps`):

> `check place: "<label>" was priced on Google place "<address>" (<area>)`

**Distinctive words:** letters only, 3+ characters, minus generic ones (`hotel`, `villa`, `resort`, `the`, `by`, `and`, `guest`, `house`, `sri`, `lanka`, `road`, `rd`).

- **Known limit, settled by Task 0.** Geocoding by place ID returns an **address**, and for a business the address may not contain the business name. If so, every genuine pick would look like a mismatch.
  - Task 0 records whether the address contains the name for three real IDs: Casa Selvita, The Find, and a large hotel.
  - If it doesn't, S2 is **not built** in Task 4b (it would only produce noise), and the check waits for Task 8, which can show the address next to the label for a human to judge.
- **Never blocks or changes a price:** it is a note to ops, best-effort like the existing `flagForOps`.

## 9. The honest "can't price" state (front-end)

`ch-pricing.js` distinguishes a **422 `quote_unpriced`** (deterministic: the server will refuse this booking) from network errors and 5xx (transient). Only the 422 is new behaviour:

- `booking.js` enters an `engineUnpriced` state for the current intent signature.
- The pay button is disabled. The summary shows: *"We couldn't price {names} automatically. Pick {it/them} again from the list, or send us the trip and we'll price it by hand."*
- It offers two actions: **Change this stop** (trip: the existing edit-trip URL, `buildTripEditUrl`; single: focus the spot field) and the existing WhatsApp button.
- The state clears as soon as the intent changes and a new estimate prices.
- Network errors keep today's fallback exactly. If the server can price at booking time, the customer pays the server's price.

## 10. Edge cases

| # | Case | Behaviour |
|---|---|---|
| E1 | Old links, bookmarks, /trip/ pages, tours (no `pids`) | Name path, exactly as today |
| E2 | Old browser JS (cached) against the new API | Fields absent, so behaviour is identical |
| E3 | **New JS against the old API** | Strict estimate schema answers 400. **Prevented by release order (§11): the API reaches prod in an earlier promotion than any page that sends the fields.** Backstopped by safeguard S1: the page retries once without place IDs |
| E4 | `stopPlaceIds` length ≠ `stops` length (client bug, reordered stops) | Field ignored and logged; prices by name as today |
| E5 | Customer picks from Google, then edits the text | Planner: the string no longer matches the map. Booking spot: `setGeo(null)` on input. No ID is sent |
| E6 | Two different places with the same display name in one planner session | The last pick wins for that string. Accepted: rare, and visible in the area line |
| E7 | Forged or foreign place ID | Priced and driven as that place.<br>• **A catalogue label can't be forged at all:** step 1 measures "Colombo Airport (CMB)", "Ella" etc. by name, whatever ID comes with it.<br>• For other labels, safeguard S2 raises an ops task at booking time when the label and Google's place clearly disagree; Task 8 later shows it on the sheet.<br>• An ID outside Sri Lanka fails the existing 900 km guard, so the stop falls through to the name path |
| E8 | Place ID `NOT_FOUND` / rotated / Google outage during resolution | Falls through to steps 3–4 (today's behaviour). An outage is never cached |
| E9 | The new identity changes a leg's km versus today's text guess | The price follows the true distance, up or down by a little. Catalogue legs are unchanged (step 1). The reprice notice (`state.pendingReprice`) already handles a figure moving mid-flow |
| E10 | **Floor guard on short hops** | `googleDistance` rounds km before comparing with 0.95 × straight-line (`maps.ts:~363-380`). A 1.4 km road rounds to 1 against a 1.3 km straight line, so 1 < 1.235 and the leg is rejected. That would wrongly unprice short coordinate legs (hotel to beach). **Fix first (Task 2):** compare unrounded metres. This bug is already live for the ops tool's resolved pairs |
| E11 | Hot zones | Unchanged: the engine keeps names (§6). Verified that zones match names only |
| E12 | Duplicate-booking matcher (`duplicateBookings.ts:35`, `norm` equality on stops) | Unchanged: stored names unchanged |
| E13 | Idempotency key / fingerprints / caches | Unchanged when no ID. With an ID, a retry that spans a release mints a new key once. Accepted, and the abandoned-draft closer (#847) covers it |
| E14 | `distance_cache` | Coordinate pairs are never cached (`cachedMaps.ts:55`, catalogue towns only). Same cost as today's hotel names, which also miss the cache |
| E15 | Gaps (traveller's own stretch) | Never measured. An ID on a gap endpoint still counts for the adjacent driven leg |
| E16 | Chauffeur trips | `engineRequestFor` chauffeur branch and `priceTrip` chauffeur both use `identifyStop` |
| E17 | Route choice (`no_tolls`) with coordinates | `measureLeg` → `distanceVariants("lat,lng", …)` works on any string. Its cache key is `norm()` of the strings: fine |
| E18 | Experiences near a stop (`/experiences/near`) | Unchanged (already sends coordinates for its own lookup) |
| E19 | Quote → booking conversion, pay links, ops quote tool | Unchanged: they don't use the public path. Their `booking_legs` place columns stay null |
| E20 | The three lost bookings | Ops prices them by hand. No backfill |
| E21 | Google bill | One Geocoding call per distinct new place ID per process per 24 h. Tests use the fake (lesson: the Maps bill was our own CI, #889) |

## 11. Compatibility and release order

**Past data: nothing is rewritten.**

| Stored today | After this change |
|---|---|
| `trip_request.stops`, `transfer_request.*_place` | Unchanged |
| `booking_legs` existing rows | Unchanged. New columns are null; coordinates stay null. **No backfill; never re-geocode a name** |
| Quotes (`quotes.intent`, `request.tool`), locked quotes | Unchanged; km frozen, never re-measured |
| Customer emails, all twelve in `notifications.ts` (route through `journey`/`routeText`/`shortPlace`) | Unchanged: they render stored names |
| Team/ops emails (`opsNotifications.ts`, webhooks, watchdog, ride board) | Unchanged. No email builds a map link today; none will in v1 |
| Manage page (`projectBooking`), pay links, quote view | Unchanged |
| Analytics (`extractLegs`, `knownPlace`, GA4 `purchaseFacts`, dataLayer) | Unchanged: names unchanged |
| Advertised catalogue prices, /trip/ pages, `distance_cache` | Unchanged (catalogue is step 1) |
| `place_resolutions` | Read-only from public paths; never written by them |

**Release order (hard gates):**
1. The API change that accepts the new fields merges to `main` (staging) **and is promoted to production on its own**.
2. **Only then** does a page that sends `fromPlaceId`/`toPlaceId`/`stopPlaceIds` merge. One promotion deploys Render and Pages together, so the API and the page must be in **different promotions**, or new JS can briefly hit an old strict schema (E3).
3. The migration (§12) ships when its PR merges (staging), and reaches prod only through the owner's promotion.

**Safeguard S1: a broken release order can't take pricing down.** If an estimate carrying place IDs gets a 400, `ch-pricing.js` re-sends it **once** with the place-ID keys removed (today's name-only request). It doesn't cache that answer and logs `estimate_retry_without_place_ids`. Only the estimate needs this: the booking bodies use Zod's default strip, so an old API ignores the new fields there instead of rejecting them. With S1, the release order in step 1–2 is still required, but it is a correctness preference, no longer an outage risk.

## 12. Schema change (one additive migration)

```sql
ALTER TABLE "booking_legs" ADD COLUMN "from_place_id" text;
ALTER TABLE "booking_legs" ADD COLUMN "to_place_id" text;
```

- Nullable and with no default, so it is a metadata-only change and existing rows are untouched.
- The coordinate columns already exist (`0042_booking_legs.sql`) and are written for the first time.
- Number: the next free number after `main`'s latest (`0073_details_reminder_kinds` on 2026-10-18, so `0074`), renumbered if taken, with `when` greater than the previous journal entry (`bookingLegsMigration.test.ts` enforces it).
- **Merging is releasing:** staging on merge, prod on promotion.

**Write rule at booking creation (website paths only):** for each derived leg endpoint:

| How the endpoint resolved | `*_place_id` | `*_lat` / `*_lng` |
|---|---|---|
| Step 1, catalogue town | null | the `COORDS` point (our own data) |
| Step 2, place ID | the ID | null by default; Google's point only if O1 allows |
| Step 3, `place_resolutions` row | null | the row's point (human-confirmed, or catalog/auto-linked to a catalog anchor) |
| Step 4, legacy text | null | null: a text guess is not an identity |

**Owner decision O1: coordinates on the booking.** What the terms check (2026-10-18) did and did not settle:

- **Verified: the place ID may be stored indefinitely.** Google's Geocoding and Places policy pages both say the place ID "is exempt from the caching restrictions" and "you can therefore store place ID values indefinitely".
- **Not verified: storing coordinates.** The same pages say storage of other content "is generally restricted". The full terms pages (Service Specific Terms §3.2.3) did not load. No exception for an order or booking record was found; the closest exception covers a street address the customer would have typed anyway.

So the **default is: store the place ID only.** The pin is resolved on demand for ops and the driver (one Geocoding call when a booking is opened, LRU-cached). Writing coordinates into `booking_legs` stays switched off until the owner, or someone who reads §3.2.3, confirms it is allowed. The columns already exist, so turning it on later is a code change, not a migration.

Catalogue towns are our own coordinates (`COORDS`), not Google content. They can always be written.

**Note:** `place_resolutions` has stored Google-derived `confirmed` coordinates indefinitely since August (#283). Whatever O1 concludes applies to that existing table too. This spec doesn't make it worse: step 3 only reads it.

## 13. Measuring, and what comes later

- **New usage counters** (existing Ops Health counters): `pricing.stop.catalogue | place_id | confirmed | text` on every measured stop, plus `pricing.unresolved`.
- **Later, separate decisions (not this spec):**
  - Retire the text path, once `text` is a small share and the honest state has shipped.
  - Teach the ops tool to accept picked place IDs.
  - August Stage 2.
  - Map links in driver/ops emails.

## 14. Testing

- **Server unit:**
  - `identifyStop` order, including the read-only `place_resolutions` lookup and never calling `resolve()`.
  - `placeById` (Google request URL, fake, invalid IDs ignored, LRU, outage not cached).
  - The floor guard with unrounded metres (the 1.4 km vs 1.3 km regression).
  - The engine receives names while `measureLeg` receives coordinates.
  - The zone boost is unchanged for a Google-picked stop in a hot-zone town.
  - The schemas accept the new fields; `TripInput` ignores a length mismatch.
  - The 422 `unresolved` list.
  - `booking_legs` writes (place IDs, coordinates, null for text).
  - **The regression for this incident:** a trip with `"Casa Selvita"` and a fake place ID prices, and without the ID it is unpriced exactly as today.
- **Compatibility tests:** byte-identical estimate/booking bodies and idempotency keys when no Google pick happened (the existing `booking-intent.test.js` suite stays untouched and green).
- **e2e (fake Places stub gains `id`):**
  - Planner Google pick → booking URL carries `pids` → the trip estimate and booking body carry `stopPlaceIds`.
  - The edit-trip round-trip keeps `pids`.
  - The 422 shows the re-pick message with no pay button.
  - A network failure keeps today's fallback.
  - The area line renders.

## 15. Rollout summary

| Order | Change | Ships | Customer-visible |
|---|---|---|---|
| 1 | Ops email on unpriced booking | API | No |
| 2 | Floor-guard metres fix | API | No (fixes rare false refusals) |
| 3 | Honest "can't price" state | Site | Yes: no dead-end pay button |
| 4 | `placeById` + `identifyStop` + schema fields + counters | API, **promoted alone** | No |
| 5 | Planner + booking trip send place IDs; area line | Site, after 4 is in prod | Yes: picked hotels price |
| 6 | Booking exact-spot fields send place IDs | Site | Yes |
| 7 | Persist identity on `booking_legs` (migration) | API + migration | No (ops data) |
| 8 | Ops view: Google name, address, Maps link, mismatch badge | Ops UI | Ops only |
| 9 | Index hero / search carry place IDs (optional) | Site | Marginal |
