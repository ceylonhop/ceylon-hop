# Ops booking pane: job first, money last, map on demand — design

Owner request 2026-11-12 (ops feedback on CH-P5F4D, plus a van booking that was sent a car).
Read against `origin/main` c472c98d. **Front end only** (owner, 2026-11-12): `api/src/routes/ops-ui.html`
plus web tests. No API, schema, migration, pricing or config change.

Visual reference: the design page at https://claude.ai/artifact/Fwxrf4JVxnXFyE3iothhmh (v3). It shows
states A–F, the map dialog, the phone view and the edge-case table.

## Problem

Ops don't press status buttons in the booking pane. They read it, then tell a vehicle coordinator
what to send. The pane is ordered for a different job:

- **The paid vehicle is easy to miss.** The header stub shows Total · Travel · Guests · Type
  (`bookingStubHtml`). The vehicle is one row inside the Trip block (`vehicleRow`), under a Route
  row that on a multi-stop trip is a paragraph of addresses. A booking paid as a van was sent a car.
- **Some booking details are never shown.** Single transfers record `adults`, `children` and
  `bags` (`domain/singleTransfer.ts:92-94`); shared bookings record `bags` (`domain/shared.ts:31,58`).
  The pane shows only the guest total.
- **A trip's route is shown twice:** the Route row and the leg list (`legsHtmlFor`).
- **Money comes before the job.** Payment and Payment attempts sit above Vehicle & pickup and
  Activity, and Payment repeats Amount and Status from the header.
- **The road isn't labelled on most legs.** Only a toll-free leg says "· local road".
- **There is no map.**
- **The pane is 500px wide for no reason.** While it is open, the scrim already covers the queue
  and blocks clicks on it (`.scrim{position:fixed;inset:0}`), so the narrow width saves nothing.

## Decisions

1. **Order by "what do I tell the coordinator?"** The job first, then what the customer asked for,
   then the customer's own note, then the team's notes. Contact, payment and history fold away.
2. **Money only rises when there is something to do.** A paid-in-full booking shows no money near
   the top. Money owed or due goes under the name (see Exceptions).
3. **Label every leg's road in ops' words** ("expressway or normal?"). Sri Lanka's tolled roads
   are its expressways, so `no_tolls` → **"No expressway"** (amber chip), and `fastest` →
   **"Expressway OK"** (quiet grey text, no chip). "Expressway OK" means Google's usual route may
   use one, not that it does; many legs have none.
4. **The map opens in a dialog, only when ops press "Map".**
5. **Keep the pill, drop the six-step bar.** The `.pipe` stepper goes; the stage pill stays.
6. **The sticky foot is unchanged.** "Confirm vehicle" / "Mark no-show" / "Copy payment reminder".
7. **No information is lost.** Every fact stays reachable. Only duplicates (the Route row, repeated
   Amount/Status) and the stepper are dropped.
8. **Wider pane.** 780px on screens at least 900px wide, with a two-column body: the job on the
   left (itinerary, customer's note), and team notes plus the folded sections on the right.
   Narrower screens keep one column, and phones keep today's full-screen sheet. The width is CSS on
   `.sheet`; the `@media(max-width:700px)` phone rule is unchanged.
9. **The ride-board pane is in scope** (state F). It gets the same treatment: departure and "will
   it run" in the header, a Map button, and Money folded to the bottom.
10. **Nothing that needs backend work.** Quote-tool internal notes (`quotes.internalNotes`) aren't
    in the detail response (`routes/ops.ts:419`), so they stay out. The "driver told?" column
    (`ride_ops.driver_update_pending_since`, migration 0075) exists, but no code writes it, so there
    is nothing to show.

11. **Colour means severity.** Amber marks an expected state that needs handling: balance due,
    cash on the day, flexible date, unpaid with more than 48 hours to travel, "May not fit". Red
    marks only what blocks the trip: unpaid with travel within 48 hours (start date, plus pickup
    time when set), or vehicle not on record. A booking with no date is amber; it has no travel
    time to measure against. The vehicle highlight is neither colour.

## Information order (website / ops bookings)

### Header (fixed)

Eyebrow (channel · type), name, ref + copy, stage pill, WhatsApp button. No stepper.

Stub row, four cells:

| Cell | Value | Sub-line |
|---|---|---|
| When | start date, or "Flexible" in amber | pickup time, or "time not set" |
| Vehicle (highlighted) | `VEHICLE_NAME[d.vehicle]` | "paid for", plus "May not fit" in amber when guests or bags exceed `vehicleCaps()` (only once the rate card is loaded; never for a custom vehicle) |
| Guests | total | "2 adults · 1 child" when the input has the split; "guests" otherwise |
| Bags | `input.bags` | "—" with "not asked" where the type doesn't record bags (trip, chauffeur) |

Per-type overrides:
- **Mid-trip** (any leg dated before today, and at least one on or after today): When becomes "Next
  leg" with that leg's date, and the sub-line reads "leg N of M · started <start>". `t.date` keeps
  meaning the start date everywhere else (spec 2026-11-06).
- **Chauffeur:** the Vehicle cell reads "<vehicle> + driver", with the sub-line "N days".
- **Shared:** When becomes "Departs" with the time. The Vehicle cell reads "N shared seats", with
  the sub-line "no vehicle to choose".
- **Vehicle unknown** (`d.vehicle` null on a non-shared booking): "Not on record — check the quote"
  in red, never blank.
- On a phone the stub keeps its first two cells (When, Vehicle), as today's 700px rule does, and
  the Vehicle sub-line becomes "paid for · N guests · M bags" (or "bags not asked"), so the
  vehicle and the party size are always seen together.

Until the detail fetch lands, Vehicle and Bags show the skeleton shimmer.

### Exceptions line (under the name, only when it applies)

One line, coloured by decision 11, and Payment opens by itself:
- awaiting payment ("Not paid yet · $X"; the "Next up" block stays first in the body)
- deposit paid, balance owed ("Balance due $X")
- pay on the day ("Cash due $X at the first pickup")
- closed (completed, cancelled, refunded, no-show): the outcome line, e.g. "Cancelled 14 Nov".
  The job details stay but are greyed.

### Body

1. **Itinerary** (trips) or **Route** (single, shared), with a "Map" button on the heading.
   - One row per leg, using today's grouping (through-stops and gaps included): date · short
     from → short to · road chip · Next / Done.
   - **Every leg still to run** shows its full From / To addresses (shared: Pick-up / Drop, from
     `fromPlace`/`toPlace` when set), so a whole trip can be arranged with one coordinator in one go.
   - **Done legs** (dated before today) collapse to one struck-out line with a "✓ Done" chip and no
     addresses. The heading reads "Itinerary · K of M left".
   - Gap legs: grey italics, "customer's own travel", no road chip.
   - Partial pay-link coverage line ("Covers 2 of 4 quoted legs") stays at the top.
   - Chauffeur: the day rows as today, plus "Driver stays N nights" (`input.driverNights`).
   - **Add-ons** (`bookingAddOns`: fixed options such as waiting time or hotel pick-up, not typed
     by the customer) sit as tags under the legs. Omitted when there are none.
   - The Change / Set date & time button and its form sit under the itinerary.
   - Short place = text before the first comma, cut to one line, with the full text as the title.
2. **Customer's note:** the free-form "Anything we should know?" box from website checkout
   (`booking.html` `#f-notes` → `bookings.customer_notes`, at most 1,000 characters). Their exact
   words in an amber callout: shown in full, `white-space:pre-line`, never truncated or folded,
   escaped like today. Empty → "No note left at checkout". A booking with no website checkout
   (an ops quote's pay link, which has no note box) → "Booked through an ops quote. That checkout
   has no note box."
3. **Team notes:** every `t.notes` entry, oldest first, with its time, plus the add-note box.
   Never only the latest: the note that matters ("child seat", "same driver") is often an older one.
   More than five → the five most recent, with "Show all N" to expand. Never zero visible.
4. **Interested in:** partner experiences, unchanged, when present.
5. Folded sections (`<details>`), closed by default, each with a one-line summary:
   Contact (phone · country, or "No WhatsApp"), Payment (status word; opens by itself under an
   exception), Vehicle & pickup (the two toggles), History (the activity list).
6. **Refund / Cancel:** as today, last, folded.

## Ride-board pane (`boardSheetHtml`)

- **Stub:** Departs (date, time, locked or window start) · Will it run (yes/no, committed of min) ·
  Seats (committed / capacity, spare) · Names close (cutoff).
- **Body:** Route with a Map button, then "Who's on it" (today's manifest rows), then Notes, then
  Money folded ("$X per seat · N of M charged").
- It stays read-only, with no foot.

## Map

- **Trigger:** "Map" on the Itinerary or Route heading. The dialog is about 920px wide, full screen
  on a phone, with the map on the left and a leg key on the right.
- **Drawing:** reuse `drawItinRoute`'s approach (`computeRoutes` per connected run, `avoidTolls` for
  `no_tolls`, pins via `mapPins`). Runs come from `stops`/`gaps`/`through`/`routeVariants` (trip),
  `from`/`to`/`routeVariant` (single), or `from`/`to` (shared, ride board). Gap legs aren't drawn.
  Done legs are drawn muted.
- **Own state:** a separate map instance and request counter from the quote tool's
  `_mapMap`/`_mapReqSeq`/`_mapPolylines`.
- **Cost:** Maps JS loads on the first press only. A second press on the same booking reuses the
  result. `MAPS_LIVE_ON` gating is unchanged.
- **Failure:** today's notes ("Google map is off on test sites", "Couldn't map this route — check
  the place names"). An unroutable run is dropped and the rest still draw.
- **Close:** ✕, Escape and scrim; focus returns to the Map button. It must sit above the side rail.

## Edge cases

| Case | Handling |
|---|---|
| Chauffeur | "+ driver · N days" in the Vehicle cell; driver nights under the itinerary |
| Gap leg | Grey italic, no road, not drawn on the map |
| Through stops | One leg, "via …" |
| Partial pay link | Coverage line, as today |
| Ops-quote booking | No note box on that checkout; the note block says so instead of "no note" |
| Long note | Shown in full with its line breaks; it pushes the right column down, never gets cut |
| No date | "Flexible" in amber, with the Set date button |
| Vehicle unknown | Red "Not on record — check the quote" |
| 9/14-seat or custom van | Full `VEHICLE_NAME` |
| Over capacity | Amber "May not fit" (needs the rate card loaded; skipped for custom) |
| Pay on the day | Exceptions line, Payment open |
| Closed stages | Outcome line, job greyed |
| Round trip | Every leg listed; one merged pin on the map |
| Two legs, one day | Both dated; no per-leg time (not stored) |
| No WhatsApp | Header button hidden; Contact summary says "No WhatsApp" |
| Long or comma-less place | Short name cut to one line; full text in the address and title |
| Map can't route | That run is dropped, the rest draw, with a note |
| Date moved after the driver had it | Not covered (no data; see decision 10) |

## Out of scope

- Quote-tool internal notes and the "driver told?" flag (both need backend work).
- Per-leg pickup times or bags on trips (not stored).
- Any change to stages, the sticky foot, or what the status buttons do.
- Server-side address shortening; changing stored stops.

## Testing

- **Unit (web-tests/unit, `loadFn` pattern):**
  - stub values per type: vehicle, chauffeur, shared, unknown vehicle, guest split, bags not asked
  - mid-trip detection and the next leg
  - exception detection: paid, deposit, cash, awaiting, closed
  - road chip per leg, with through-runs and gaps
  - short place
  - booking → map runs (trip with a gap, a through-stop and a `no_tolls` leg; a single; a shared
    booking; a ride-board van)
- **E2E (Playwright, maps stubbed):**
  - the trip pane shows the vehicle in the header and the itinerary first
  - a mid-trip trip shows done legs struck out and the next leg in the header
  - Payment is closed when paid and open with a balance
  - a fold stays open across a diff-render refresh
  - the Map dialog opens, closes and returns focus
  - the 780px two-column layout at desktop width; one column below 900px
  - the ride-board pane shows the new stub
  - nothing is lost: every field from today's pane is present somewhere in the DOM
- **Existing specs** that target the Trip/Payment blocks, the pipe or the board sheet get selector
  updates (expected churn).
- **Browser check:** multi-stop (before and mid-trip), single, deposit, pay on the day, awaiting
  payment, shared, chauffeur, ride board, and phone width.
- **Gate:** `cd api && npm run check` and `npm run test:all` green before every commit;
  `npm run stamp` if a root asset changes.

## Risks

- **`ops-ui.html` is the hot file.** Small PRs, merged quickly. Consider two PRs: (1) the pane
  order, width and folds; (2) the map dialog.
- **morphdom and `<details>`:** a refresh must not snap a fold shut. Keep the open state in render
  state, or have `onBeforeElUpdated` preserve `open`.
- **Maps billing:** press-only and `MAPS_LIVE_ON`-gated; e2e stubs `google.maps`.
