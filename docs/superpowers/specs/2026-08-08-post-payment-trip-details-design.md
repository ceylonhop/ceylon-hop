# Post-payment trip details (customer-completed pick-up & drop-off) — design

Let a customer add their exact pick-up spot, drop-off spot and time **after** they have paid —
on the payment success screen and on the booking page they keep in email — without ever asking
them for more money, and without letting a typed hotel silently change what was priced.

## Problem

A quote pay link never records a departure time or an exact spot. `pay.html` says so in code
(`renderPaid`, line ~322): *"a quote pay link never records a departure time, so rather than print
'To confirm' into a keepsake, the row is simply not there."* The boarding pass shows Date,
Travellers, Vehicle, Paid — never where to actually meet.

That is deliberate. The website booker asks for an exact spot and a time up front; the quote →
pay-link path exists **for customers whose details are not settled yet** (owner, 2026-08-08). The
gap is that nothing ever closes the loop afterwards. The site even promises it will —
`booking.js:549`: *"we'll fine-tune every stop and time with you after booking"* — and then the only
channel for that promise is WhatsApp, transcribed by hand.

Two further facts shape the design:

- **A booking already has somewhere to put this.** A quote-born booking lands in the same tables as
  a website booking (`postgresQuoteConversionRepo.ts:151-175`): `transfer_request` for `mode:
  'single'`, with `from_place`, `to_place`, `travel_date` and a nullable `travel_time`. This is late
  completion of existing fields, not a new parallel record of "where to collect someone".
- **An exact spot is a priced input, not a note.** The booker treats it that way: `booking.js:233`
  ("how far a customer's exact pick-up/drop-off drifts before we re-price") and the 10 km
  `MAX_EXACT_KM` hard block in `transfers-data.js:242`. Before payment, drift re-prices. After
  payment there is nothing to re-price into — so the same rule needs a different resolution.

## Requirements (owner, 2026-08-08)

1. **The ask must feel optional.** Most customers on this path do not know their hotel yet; that is
   why the path exists. A collapsed row that leads with "you may not know yet", never a form that
   reads as owed.
2. **It must be answerable later**, not only on the success screen.
3. **Stored on the booking**, visible where the driver is assigned — not emailed, not WhatsApp-only.
4. **Private point-to-point only.** Not shared taxi, not ride board, not chauffeur.
5. **A multi-leg trip is point-to-point × N** — the same card repeated per leg, not a different
   product.
6. **The out-of-area control must work post-payment.**
7. **Flight number only when that leg's pick-up is an airport.**
8. **Never ask the customer for more money on this screen.** A legitimate spot that adds distance is
   saved and flagged to ops; the customer sees nothing about price.

## Design

### 1. Booking legs — giving each journey its own record

Today a trip is one `trip_request` row holding parallel arrays: `stops[]`, `nights[]`, `dates[]`.
A journey is a **position between two array entries** — it has no identity. Attaching a customer's
hotel to a position fails silently whenever the trip changes: insert a stop and every later journey
shifts down, wearing the previous occupant's hotel. Nothing looks wrong on any screen; the driver is
simply sent to the wrong town.

Add **`booking_legs`** — one row per journey, with its own id.

| Column | Type | Meaning |
|---|---|---|
| `id` | `uuid pk` | the leg's identity; what a customer's answer is addressed to |
| `booking_id` | `uuid → bookings.id` | |
| `seq` | `integer` | order within the trip, 1-based (display only — never an identifier) |
| `from_place` / `to_place` | `text` | the **priced** endpoints, copied from `stops[]` / `transfer_request` |
| `travel_date` | `text null` | from `dates[]`; null when the trip has no dates yet |
| `pickup_spot` / `dropoff_spot` | `text null` | what the customer typed |
| `pickup_lat` / `pickup_lng` | `double null` | what the server resolved it to — evidence, so an ambiguous label is diagnosable later |
| `dropoff_lat` / `dropoff_lng` | `double null` | |
| `pickup_time` | `text null` | `HH:MM`; null = "I'll confirm later" |
| `flight_no` | `text null` | only ever set on an airport pick-up |
| `detail_flag` | `text null` | `unverified` \| `over_buffer`; null = clean |
| `details_updated_at` | `timestamptz null` | when the customer last saved this leg |
| `removed_at` | `timestamptz null` | soft-delete; a leg dropped from the trip keeps its details |

`bookings.customer_note` (new, nullable) holds the one trip-level free-text note.

**`trip_request` and `transfer_request` are not touched.** They stay the priced record, and every
existing reader (`opsView`, `notifications`, `pricing`, `bookings`, `internalQuote`,
`analytics/extractLegs`) keeps working unchanged. `booking_legs` carries **identity and customer
detail**; the request tables carry **what was priced**. Pre-payment those agree by construction;
post-payment they can legitimately disagree, and flattening them would erase why the price is what
it is.

**Departure time has one source of truth: the leg.** `transfer_request.travel_time` already exists
and already means departure time, so leaving it behind would create the second home for "when do we
collect them" that this design otherwise avoids. Rule: the backfill copies `travel_time` **into**
`booking_legs.pickup_time`, the leg is authoritative from then on, and a save on a `mode: 'single'`
booking **mirrors the value back** to `transfer_request.travel_time` in the same transaction — so
every existing reader (ops view, emails, digests) keeps showing a time without being rewritten.
Multi-leg trips have no such column to mirror to: `trip_request` has no time field at all, which is
the other half of why legs are needed.

**Written for every booking with a route** — `mode: 'single'` produces exactly one leg, `mode:
'trip'` produces `stops.length - 1`, both service types. `mode: 'shared'` produces none: a shared
seat is a corridor and a timetable, not journeys with editable ends. Legs are created in the same
transaction as the request row, in both writers (`postgresBookingRepo.ts:226/248` and
`postgresQuoteConversionRepo.ts:151/163`).

> **Decision to sanity-check:** legs are created for chauffeur trips too, even though the card never
> shows for them. A half-normalised model ("which bookings have legs?") is its own trap. The gate
> lives in one place — the card and the endpoint — not in the storage.

**When ops edits a trip**, legs are re-derived and **matched by endpoint pair `(from_place,
to_place)` in order — never by position**. Matched legs keep their details. Unmatched old legs are
soft-deleted via `removed_at`, not deleted: a customer's answer is never silently destroyed, and
"they never told us" stays distinguishable from "that journey no longer exists".

### 2. What the customer is asked

A collapsed `<details>` row — closed on arrival, the keepsake stays the hero.

> **Know your hotel yet?**
> Add your pick-up spot and time whenever you have them — right up to the day before.

Opened, per leg:

| Field | Notes |
|---|---|
| Pick-up — hotel or address | plain text; **no autocomplete** (see §5) |
| Pick-up time | select, default **"I'll confirm later"**. A blank time field pressures a guess, and a wrong pick-up time is worse than none |
| Drop-off — hotel or address | plain text |
| Flight number | **only when this leg's pick-up is an airport** — `isAirportPlace` (`api/src/quote/payPageCopy.ts:108`) |
| Anything we should know | once per booking, not per leg |

**Airport pick-up variant.** When `isAirportPlace(from_place)`, the pick-up field is labelled for a
terminal / arrivals point rather than a hotel, and the time field is labelled as the flight's
arrival time. An airport pick-up is the case where the driver must track a flight and wait.

**Carried-forward hotel.** On a multi-leg trip, leg N's drop-off is usually leg N+1's pick-up — they
slept there. `nights[]` already records it. When consecutive legs share a stop the next leg offers
*"same as your Ella hotel"* instead of an empty box. Without this, "point-to-point × N" becomes
"type your hotel 2N times" and the optionality in requirement 1 dies in practice.

**Saved state.** The row is replaced by what we now hold, plus **Edit**. A wrong hotel must be
visibly wrong. This is also what a returning visit renders.

### 3. Where it appears, and for whom

Rendered on **`pay.html`**'s paid screen (between the pass and "What happens next") and on
**`manage.html`**. `notifications.ts:321` emails a `manage.html?t=<signed booking token>` link — that
is the link customers keep, so without it "add it whenever" is a promise with nowhere to land.

One definition, loaded by both pages: a new shared `trip-details.js` + its styles alongside
`ticket.css`. **It must be added to `ASSETS` in `api/src/routes/customerPages.ts:51`** — these pages
are served from the API host, and an asset missing from that list 404s there while working locally.

**Gate: show only when the booking has `booking_legs` and is private point-to-point** — i.e. `mode:
'single'`, or `mode: 'trip'` with `serviceType: 'private'`. Chauffeur, shared and ride board are
excluded. Written as a positive test, so a product type invented later defaults to hidden rather
than to showing a form that does not fit it.

### 4. Saving

`POST /bookings/details`, authed by the **existing signed booking token** (`signBookingToken`) — the
same token that already opens the booking view. No new auth surface.

```
{ legs: [ { legId, pickupSpot?, dropoffSpot?, pickupTime?, flightNo? } ], note? }
```

Answers are addressed to **`legId`**, never to a position. If a leg has been removed since the page
loaded — ops edited the trip while the customer was typing — the endpoint answers **409** and the
card re-renders the trip as it now stands, rather than landing the answer on whatever occupies that
position. Re-submission overwrites; `details_updated_at` moves.

Bounded input (length caps per field) and no field that feeds pricing is writable.

### 5. The guard, server-side

The page sends plain text and the **server** resolves it (existing `placeResolver`, which already
caches to `place_resolutions`). Two reasons: the page stays simple, and post-payment this guard is
the only thing standing between a typed hotel and a dispatched driver — a client-side-only check on
a public page is not a guard.

Per leg, per end:

| Band | Condition | Behaviour |
|---|---|---|
| **Refuse** | resolved spot > `MAX_EXACT_KM` (10 km) from that leg's priced endpoint | **422.** Card shows the booker's out-of-area block, colours as `booking.js:981`. Copy adapted: "change your search on the home page" is meaningless once paid, so the action is **WhatsApp us**. Nothing is stored. |
| **Flag — unverified** | coordinates unresolvable | Saved, `detail_flag = 'unverified'`, raised to ops. Pre-payment the rule fails open because checkout re-confirms the price; post-payment nothing re-confirms, so failing open must mean *flagged*, not silent. |
| **Flag — over buffer** | resolvable and within 10 km, but routed distance exceeds `billableKm(anchor)` | Saved, `detail_flag = 'over_buffer'` with the km delta for ops. **The customer is told nothing about money** (requirement 8). |
| **Clean** | within buffer | Saved, no flag. |

**One definition of the 10 km rule.** `MAX_EXACT_KM` currently lives only in front-end
`transfers-data.js`. It moves into the backend rate-card constants and is emitted into
`transfers-data.js` by the existing generator (`tools/generate-pricing.mjs`, sentinels
`@generated:pricing` … `@end:pricing`), exactly as prices already are. Server canonical, front-end
generated — not a second hand-maintained copy that drifts.

### 6. Ops

A block on the boarding-pass booking sheet, per leg: pick-up spot, drop-off spot, time, flight
number, plus the booking's note. Chips when a leg is flagged — **Unverified spot** or **Adds N km** —
and a quiet marker when a leg is still unanswered. It sits on the sheet already opened to assign a
driver; nothing new to check.

Read-only in v1. Ops editing these values is deferred.

### 7. Migration and rollout

Migrations auto-apply on Render boot and **fail closed** — a migration that throws stops the API from
booting. The backfill therefore must be defensive and idempotent:

- Create `booking_legs`, backfill from `transfer_request` (1 leg) and `trip_request`
  (`stops.length - 1` legs), including bookings already **paid**.
- Tolerate malformed rows: a `stops` array shorter than 2, a `dates` array of the wrong length, or a
  null — skip that booking, do not throw. A historical row must never be able to keep the API down.
- Re-runnable: keyed on `(booking_id, seq)` so a partial run completes rather than duplicates.

No customer-facing behaviour changes on deploy: the card renders only where legs exist and the
booking qualifies, and an unanswered card changes nothing about the trip.

### 8. Tests

- **Guard bands** — inside / outside 10 km / unresolvable / over-buffer, per leg, per end.
- **Leg matching** — insert a stop mid-trip and assert details stay with their journey (the failure
  this whole section exists to prevent); removal soft-deletes rather than reassigns.
- **Backfill** — single, multi-leg, malformed rows skipped, idempotent on re-run.
- **Endpoint** — bad/absent token rejected; 409 on a removed leg; re-submission overwrites.
- **Gate** — card absent for shared, chauffeur and ride board; present for single and private trip.
- **Airport variant** — flight field present only when the leg's pick-up is an airport.
- **DOM contract + Playwright** for the card on `pay.html` and `manage.html`, per `web-tests`.

### 9. Out of scope

- **Chauffeur, shared taxi and ride board** — excluded by product rule, not deferred.
- **Any change to emails or reminders.** The existing `manage.html` link is the return path.
- **Collecting more money, or re-pricing anything.** Nothing in this build touches price.
- **Ops editing these fields** — display only in v1.
- **Places autocomplete on the customer page** — resolution is server-side by design (§5).
