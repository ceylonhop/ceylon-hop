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
4. **Private point-to-point and chauffeur.** Not shared taxi, not ride board. (Revised 2026-08-08:
   chauffeur was initially excluded on the mistaken grounds that it is "a car retained, not journeys
   with two ends". The engine says otherwise — `chauffeur.ts:60-64` charges a day rate **plus per-km
   on each travel day's route**, buffered with the same `billableKm` as a private leg. A chauffeur
   day is a journey, and its customer is collected from a hotel like anyone else.)
5. **A multi-leg trip is point-to-point × N** — the same card repeated per leg, not a different
   product.
6. **The out-of-area control must work post-payment.**
7. **Flight number only when that leg's pick-up is an airport.**
8. **Never ask the customer for more money on this screen.** A legitimate spot that adds distance is
   saved and flagged to ops; the customer sees nothing about price.

## Delivery: two phases, separately verified

The riskiest part of this build is the part nobody can see. Leg normalisation and its backfill touch
bookings **already paid for** and deliver no customer-visible value on their own; the card is
comparatively cheap and reversible. They ship as two changes, not one:

- **Phase 1 — legs.** The `booking_legs` table, both writers, the re-derivation rule, the backfill.
  No UI, no endpoint, no customer-visible change. Verified in prod (leg counts reconcile against
  `stops[]`, skip count is zero or explained) **before** Phase 2 begins.
- **Phase 2 — the card.** Endpoint, guard, both pages, ops surface, instrumentation.

A single-transfer-only version of Phase 2 needs no new table at all; that option is closed by
requirement 5, but it is why the phases must not be merged.

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
| `from_lat` / `from_lng` / `to_lat` / `to_lng` | `double null` | resolved endpoints — the basis for re-derivation matching (§1.1) and the guard's anchor |
| `travel_date` | `text null` | from `dates[]`; null when the trip has no dates yet |
| `pickup_spot` / `dropoff_spot` | `text null` | what the customer typed |
| `pickup_lat` / `pickup_lng` / `dropoff_lat` / `dropoff_lng` | `double null` | what the server resolved it to — evidence, so an ambiguous label is diagnosable later |
| `pickup_time` | `text null` | `HH:MM`; null = "I'll confirm later" |
| `flight_no` | `text null` | only ever set on an airport pick-up |
| `detail_flag` | `text null` | `unverified` \| `over_buffer` \| `needs_reconfirm` \| `late_change`; null = clean |
| `distance_check` | `text null` | `ok` \| `unavailable` — whether the routed-distance check actually ran (§5) |
| `refused_spot` / `refused_at` | `text null` / `timestamptz null` | a spot we refused, kept on purpose (§5) |
| `details_history` | `jsonb null` | append-only prior values, newest last (§7) |
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

**Written for every booking with a route** — `mode: 'single'` produces exactly one `leg` row,
`mode: 'trip'` produces `stops.length - 1` `leg` rows for a private trip and one `day` row per
travel day for a chauffeur trip (§1.1). `mode: 'shared'` produces none: a shared
seat is a corridor and a timetable, not journeys with editable ends. Legs are created in the same
transaction as the request row, in both writers (`postgresBookingRepo.ts:226/248` and
`postgresQuoteConversionRepo.ts:151/163`).

#### 1.1 Two kinds of row: the leg and the travel day

A private trip and a chauffeur trip are both journeys priced by the kilometre, but their **unit
differs**, so `booking_legs` carries a `kind` column:

| `kind` | Unit | Source | Endpoints |
|---|---|---|---|
| `leg` | one journey between two overnight stops | `transfer_request`, or a consecutive pair in `trip_request.stops[]` | `from_place` → `to_place` |
| `day` | one **travel day** | `ChauffeurRideDay` — `{ date, stops[], segmentKms[] }` (`quote/types.ts:12`) | first stop → last stop; `via_stops` (text array) holds the rest |

A chauffeur travel day is often multi-stop, and the stops in between are **itinerary, not
accommodation** — the customer sleeps at the ends, so only the ends are asked about. `via_stops` is
recorded for ops context and never prompted for.

**Idle days produce no row.** They have no journey: the car is parked and inherits the last travel
day's location (`chauffeur.ts:44-47`). Nothing to collect, nothing to ask.

Everything downstream — the guard, the matching rule, the card, the ops block — treats both kinds
identically, keyed on the row's two endpoints. The only difference is what the row was derived from.

#### 1.2 Re-deriving legs when a trip is edited

Matching new legs to old ones **by label string is not safe**. Ops correcting "Yala" to "Yala
National Park" — the exact ambiguous-place-label case already on record — would fail to match, and a
typo fix would orphan a customer's hotel. Repeated pairs (`A→B` on the way out and back) are
ambiguous under string matching too. So:

1. **Match on resolved coordinates, not labels.** A leg matches a new journey when both endpoints
   resolve within **2 km** of the old ones, scanning in sequence order. A rename resolves to the same
   coordinates and therefore matches; a genuinely different place does not.
2. **Never guess.** If two candidates match equally well (a genuine repeated pair, or a reordered
   trip), do not pick one. Keep the details in place and set `detail_flag = 'needs_reconfirm'`.
3. **A material move keeps the details and flags them.** If an endpoint moves more than 2 km, the
   leg is retained with its details and `needs_reconfirm` — never silently reassigned, never
   silently emptied.
4. **Only a journey that has genuinely disappeared is soft-deleted** (`removed_at`), and only after
   steps 1–3 find no home for it.

`needs_reconfirm` shows in ops as a chip, and the customer's card renders that leg's saved answer
with a quiet "please confirm this is still right". A break is made **visible**, which is the whole
point of giving legs identities in the first place — a rule that fails silently is no better than
the positions it replaced.

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

**Known limitation — airport drop-offs stay blind.** Requirement 7 puts the flight field on
pick-ups only, which is operationally right, but it means a customer flying *out* of CMB still never
tells us their flight. Pick-up time becomes the only lever, and a wrong guess misses a plane. The
drop-off field's placeholder therefore invites the flight time in free text
("e.g. Jetwing Blue — flight at 21:30"), and the note field remains available. Revisit if ops finds
they are still chasing departure times by hand.

**Carried-forward hotel.** On a multi-leg trip, leg N's drop-off is usually leg N+1's pick-up — they
slept there. `nights[]` already records it. When consecutive legs share a stop the next leg offers
*"same as your Ella hotel"* instead of an empty box. Without this, "point-to-point × N" becomes
"type your hotel 2N times" and the optionality in requirement 1 dies in practice. The two fields
stay independent once edited — a customer may legitimately change hotels mid-stay.

**Saved state.** The row is replaced by what we now hold, plus **Edit**. A wrong hotel must be
visibly wrong. This is also what a returning visit renders.

### 3. Where it appears, and for whom

Rendered on **`pay.html`**'s paid screen (between the pass and "What happens next") and on
**`manage.html`**. `notifications.ts:321` emails a `manage.html?t=<signed booking token>` link — that
is the link customers keep, so without it "add it whenever" is a promise with nowhere to land.

One definition, loaded by both pages: a new shared `trip-details.js` + its styles alongside
`ticket.css`. **It must be added to `ASSETS` in `api/src/routes/customerPages.ts:51`** — these pages
are served from the API host, and an asset missing from that list 404s there while working locally.

**Gate: show only when the booking has `booking_legs`** — which is `mode: 'single'`, or `mode:
'trip'` at either service type. Shared taxi and ride board are excluded, and the reason holds: a
shared seat is a corridor and a timetable with set meeting points, so there is nothing for the
customer to specify. Written as a positive test, so a product type invented later defaults to hidden
rather than to showing a form that does not fit it.

**On a chauffeur booking the card reads by day** — *"Day 2 · Fri 22 Aug"* rather than a route pair —
and asks where to collect them that morning, at what time, and where the day ends. Idle days are not
listed. Everything else about the card is identical.

**Closed bookings show nothing.** When the booking is `cancelled`, `refunded`, `completed` or
`no_show`, the card is not rendered and the endpoint answers **410**. There is nothing useful about
collecting a pick-up spot for a trip that is over or called off.

### 4. Saving, and what the write token may do

`POST /bookings/details`, authed by the **existing signed booking token** (`signBookingToken`).

```
{ legs: [ { legId, pickupSpot?, dropoffSpot?, pickupTime?, flightNo? } ], note? }
```

**This token has no expiry.** `signBookingToken` signs `{ id: bookingId }` and nothing else
(`api/src/lib/bookingToken.ts:32`). As a *read* link that is the accepted status quo; turning it
into a *write* link is a real escalation — a forwarded confirmation email or a screenshot would
otherwise let anyone rewrite a pick-up address forever. Rather than break every link already in
customers' inboxes by adding an `exp`, writes are constrained server-side:

| Constraint | Rule |
|---|---|
| **Booking state** | writes only while the booking is open (§3); otherwise 410 |
| **Time window** | writes accepted until the leg's `travel_date` begins; after that, read-only |
| **Late changes** | a write inside 48 h of `travel_date` is saved **and** flagged `late_change`, because a driver may already be assigned |
| **Rate limit** | per token and per IP; this endpoint writes text fields, so a low ceiling costs nobody |
| **Evidence** | every write appends to `details_history` (§7) with a timestamp and a hashed client fingerprint |

Nothing that feeds pricing is writable, so the blast radius is bounded to detail fields — but
"bounded" is not "harmless" when the field decides where a driver goes.

**Answers are addressed to `legId`, never to a position.** If a leg has been removed since the page
loaded — ops edited the trip while the customer was typing — the endpoint answers **409**, and the
card re-renders the trip as it now stands **while preserving what they typed**, re-attaching values
to legs that still match. Their typing is never discarded to show them a refresh.

Re-submission overwrites; `details_updated_at` moves; the previous value is appended to
`details_history`.

### 5. The guard, server-side

The page sends plain text and the **server** resolves it (existing `placeResolver`, which already
caches to `place_resolutions`). Two reasons: the page stays simple, and post-payment this guard is
the only thing standing between a typed hotel and a dispatched driver — a client-side-only check on
a public page is not a guard.

**The synchronous path makes no Maps call.** Refusal is a straight-line (haversine) test against the
leg's resolved endpoint, exactly as the booker's hard block works. The customer's save is never
waiting on Distance Matrix.

Per leg, per end:

| Band | Condition | Behaviour |
|---|---|---|
| **Refuse** | resolved spot > `MAX_EXACT_KM` (10 km) from that leg's priced endpoint | **422.** Card shows the booker's out-of-area block, colours as `booking.js:981`. Copy adapted: "change your search on the home page" is meaningless once paid, so the action is **WhatsApp us**. The leg's details are unchanged — but the attempt **is** recorded (below). |
| **Flag — unverified** | coordinates unresolvable | Saved, `detail_flag = 'unverified'`, raised to ops. Pre-payment the rule fails open because checkout re-confirms the price; post-payment nothing re-confirms, so failing open must mean *flagged*, not silent. |
| **Flag — over buffer** | resolvable and within 10 km, but routed distance exceeds `billableKm(anchor)` | Saved, `detail_flag = 'over_buffer'` with the km delta for ops. **The customer is told nothing about money** (requirement 8). |
| **Clean** | within buffer | Saved, no flag. |

**A refusal is recorded, not discarded.** The typed text, its resolved coordinates and the distance
go to `refused_spot` / `refused_at`, and ops gets a signal. A customer asking to be collected 40 km
from where they were sold a trip is the highest-signal event in this feature — their real intent
differs from what you sold. Refusing them *and* never finding out would be the wrong half of the
behaviour.

**The routed-distance check runs after the response, not during it.** The save returns immediately
on the haversine result; the Distance Matrix call then sets `over_buffer` if warranted. If Maps is
unavailable or the place is ambiguous, `distance_check = 'unavailable'` — the leg is visibly
**unchecked** rather than silently clean, which is the failure mode the open Maps-fallback audit
finding warns about.

**One definition of the 10 km rule.** `MAX_EXACT_KM` currently lives only in front-end
`transfers-data.js`. It moves into the backend rate-card constants and is emitted into
`transfers-data.js` by the existing generator (`tools/generate-pricing.mjs`, sentinels
`@generated:pricing` … `@end:pricing`), exactly as prices already are. Server canonical, front-end
generated — not a second hand-maintained copy that drifts.

### 6. Ops

A block on the boarding-pass booking sheet, per leg: pick-up spot, drop-off spot, time, flight
number, plus the booking's note. Chips when a leg is flagged — **Unverified spot**, **Adds N km**,
**Please re-confirm**, **Changed late**, **Distance unchecked** — a quiet marker when a leg is still
unanswered, and a **Refused: "<what they typed>"** line when there is one. Removed legs that carry
customer details appear in a collapsed "removed journeys" area rather than vanishing; a leg with no
details is dropped silently.

It sits on the sheet already opened to assign a driver; nothing new to check.

Read-only in v1. Ops editing these values is deferred.

### 7. Evidence and history

Overwrite-in-place with no history has an obvious failure: *"I told you the Dots Bay House"* and
nothing to check it against. `quote_revisions` is the existing precedent for the opposite.

Each write appends the **previous** value to `details_history` — an append-only JSON array of
`{ at, pickupSpot, dropoffSpot, pickupTime, flightNo, source, fingerprint }`, newest last, capped at
20 entries per leg. Cheap, self-contained, no new table, and enough to answer who said what when.

### 8. Instrumentation

The premise of this feature is a guess: *will customers who do not know their hotel come back later
and tell us?* Shipping it unmeasured means never learning the answer. The booker already tracks
`exact_location_out_of_range` and `reprice_shown`; the same `chTrack` pattern applies.

| Event | Why |
|---|---|
| `trip_details_shown` (with `source`: pay \| manage) | denominator |
| `trip_details_opened` | did the quiet ask get noticed at all |
| `trip_details_saved` (fields filled, legs answered) | the actual conversion |
| `trip_details_refused` (km) | how often intent diverges from what was sold |
| `trip_details_later` | pressed "I'll do this later" |

Server-side counters back the same events, since a customer arriving days later from an email link
is exactly the case a page-only funnel loses. **Success criterion, stated up front:** if fewer than
a fifth of qualifying bookings ever save details, the card is not earning its keep and WhatsApp was
the right answer.

### 9. Migration and rollout

Migrations auto-apply on Render boot and **fail closed** — a migration that throws stops the API from
booting. The backfill therefore must be defensive and idempotent:

- Create `booking_legs`, backfill from `transfer_request` (1 leg) and `trip_request`
  (`stops.length - 1` legs), including bookings already **paid**.
- Tolerate malformed rows: a `stops` array shorter than 2, a `dates` array of the wrong length, or a
  null — skip that booking, do not throw. A historical row must never be able to keep the API down.
- **Skips are counted, not silent.** The count and the skipped booking references are logged, and
  exposed as a one-line ops figure. A booking with no legs shows no card and would otherwise be
  invisible.
- Re-runnable: keyed on `(booking_id, seq)` so a partial run completes rather than duplicates.

No customer-facing behaviour changes on Phase 1 deploy: the card does not exist yet.

### 10. Tests

- **Guard bands** — inside / outside 10 km / unresolvable / over-buffer, per leg, per end.
- **Refusal is recorded** — 422 leaves details untouched *and* writes `refused_spot`.
- **Leg re-derivation** — a renamed endpoint keeps its details (coordinate match); a repeated pair
  flags `needs_reconfirm` instead of guessing; an inserted stop leaves existing details with their
  own journey; a removed journey soft-deletes rather than reassigns.
- **Backfill** — single, multi-leg, malformed rows skipped and counted, idempotent on re-run.
- **Endpoint** — bad/absent token rejected; 410 on a closed booking; write refused after
  `travel_date`; `late_change` flag inside 48 h; 409 on a removed leg preserves input; re-submission
  overwrites and appends to `details_history`.
- **Gate** — card absent for shared taxi and ride board; present for single, private trip and
  chauffeur. Idle chauffeur days produce no row and no ask.
- **Airport variant** — flight field present only when the leg's pick-up is an airport.
- **DOM contract + Playwright** for the card on `pay.html` and `manage.html`, per `web-tests`.

### 11. Out of scope

- **Shared taxi and ride board** — excluded by product rule, not deferred.
- **Any change to emails or reminders.** The existing `manage.html` link is the return path.
- **Collecting more money, or re-pricing anything.** Nothing in this build touches price.
- **Ops editing these fields** — display only in v1.
- **Places autocomplete on the customer page** — resolution is server-side by design (§5).

### 12. Decisions taken here, and why

These are recorded so a later reader knows they were chosen rather than defaulted into.

1. **Write-token constraints (§4) — decided.** Existing emailed links keep working; writes are
   fenced by booking state, a travel-date cutoff, a rate limit and a late-change flag. The
   alternative, adding an `exp`, invalidates links already sitting in customers' inboxes to buy
   protection the fences already give. The thing worth *noticing* is not the choice but the fact
   underneath it: a token that until now only revealed a booking can now change where a driver goes.
2. **Chauffeur is in, by travel day (§1.1) — owner, 2026-08-08.** Superseding the first draft's
   exclusion. Chauffeur is priced per kilometre on each travel day's route plus a day rate, so its
   customers are collected from a hotel exactly like a private transfer's. The unit is the dated
   travel day rather than the stop pair, and idle days are not asked about.
3. **The one-in-five success criterion (§8) — provisional.** A number chosen to make the feature
   falsifiable, not handed down. It gates nothing in the build and should be revisited once real
   numbers exist; its only job is to stop "did this work?" from being answered by impression.
