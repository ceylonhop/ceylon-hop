# Ops booking pane: job first, money last, map on demand — design

Owner request 2026-11-12 (ops feedback on CH-P5F4D, plus a van booking that was sent a car).
Read against `origin/main` c472c98d. Front end only: `api/src/routes/ops-ui.html` plus web tests.
No API, schema, migration, pricing or config change.

## Problem

Ops don't press status buttons in the booking pane. They read it, then tell a vehicle coordinator
what to send. The pane is ordered for a different job, so the facts that matter for dispatch are
scattered and some are below the fold:

- **The paid vehicle is easy to miss.** The header stub shows Total · Travel · Guests · Type
  (`bookingStubHtml`). The vehicle is one row inside the Trip block (`vehicleRow`), under the
  Route row. On a multi-stop trip the Route row is a paragraph of full addresses, so the vehicle
  sits below it. With "3 guests" up top and nothing saying "Van" beside it, a booking paid as a van
  was sent a car.
- **Some booking details are never shown.** Single transfers record `adults`, `children` and
  `bags` (`domain/singleTransfer.ts:92-94`); the pane shows only the guest total and never the bags.
- **A trip's route is shown twice:** the Route row and the leg list (`legsHtmlFor`).
- **Money comes before the job.** Payment and Payment attempts sit above Vehicle & pickup and
  Activity, and Payment repeats Amount and Status from the header. For a booking that is simply
  paid, none of it needs reading.
- **The road isn't labelled on most legs.** A leg priced on the toll-free road shows "· local road";
  a leg on the default road shows nothing, so ops can't tell "default road" from "not recorded".
- **There is no map.** Ops asked to see the route (e.g. Negombo → Ella, expressway or not).

## Decisions

1. **Order by "what do I tell the coordinator?"** The job comes first, then what the customer asked
   for, then the team's own notes. Contact, payment and history fold away.
2. **Money only rises when there is something to do.** A paid-in-full booking shows no money near
   the top. When money is owed or due, it goes straight under the name (see Exceptions).
3. **Label every leg's road.** `fastest` → "Fastest road", `no_tolls` → "Local road". Not
   "Expressway": `fastest` is Google's default route, and many legs (Ella → Panama) have no
   expressway at all.
4. **The map opens in a dialog, only when ops press "Map".** It is never inside the 500px pane and
   never loads on open.
5. **Keep the pill, drop the six-step bar.** The stage pill beside the ref takes no row of its own
   and still says Awaiting payment / Completed / Cancelled. The `.pipe` stepper (`sheetHeadHtml`,
   about 80px) goes from the booking pane. Ride-board sheets are untouched.
6. **The sticky foot is unchanged.** "Confirm vehicle" / "Mark no-show" and the payment-reminder
   button stay as they are. Removing them is a separate decision.
7. **No information is lost.** Every fact on today's pane is still reachable, moved or folded. The
   only things dropped are duplicates (the Route row, the repeated Amount/Status rows) and the
   stepper, whose information the pill already carries.

## Information order

### Header (fixed, does not scroll)

Eyebrow (channel · type), name, ref + copy, stage pill, WhatsApp button: as today, without the stepper.

Stub row, four cells, replacing Total · Travel · Guests · Type:

| Cell | Value | Sub-line |
|---|---|---|
| When | start date (`t.date`), or "Flexible" | pickup time (`t.time`), or "time not set" |
| Vehicle | `VEHICLE_NAME[d.vehicle]`, highlighted | "paid for". A shared seat shows "Shared seat". |
| Guests | total | "2 adults · 1 child" when the input has the split; "guests" otherwise |
| Bags | `input.bags` | "—" with "not asked" where the booking type doesn't record bags (trip, chauffeur) |

Until the detail fetch lands, Vehicle and Bags show the skeleton shimmer, not a guess.

### Exceptions line (under the name, only when it applies)

One red line, and the Payment section opens by itself, when any of these holds:

- awaiting payment (today's "Next up" block stays first in the body, as now)
- deposit paid, balance owed (today's `pill-bal` "Balance $X" tag becomes this line)
- pay on the day, cash to collect (today's "Cash due $X" tag)

A plain paid booking shows no exceptions line.

### Body

1. **Itinerary**, with a "Map" button on its heading.
   - Trip: one row per leg (today's `legsHtmlFor` grouping, through-stops and gaps included). The
     row reads date · short from → short to, followed by a road chip and the Next / done styling it
     already has. The **next** leg also shows its full pick-up and drop-off addresses underneath;
     other legs stay on one line. A gap leg keeps its "customer's own travel" wording and has no road chip.
   - Single / private / chauffeur: the same one-line row for the route, with the full addresses
     under it and a road chip.
   - The separate Route row and single-transfer "Road" row go; this replaces them.
   - The When row's Change / Set date & time button and its form move here, under the itinerary.
   - "Short" place = the text before the first comma of the stored stop (display only; the full
     string stays in the address line and the map).
2. **Customer asked for:** extras (`bookingAddOns`) and the customer's note (`customerNotes`),
   together. Shows "No extras · no note" when both are empty, so absence reads as checked.
3. **Team notes:** the latest internal note (`t.notes`, last entry) and the add-note box. The full
   list is under History.
4. **Interested in:** partner experiences, unchanged, when present.
5. Folded sections, closed by default, each with a one-line summary on the closed row:
   - **Contact:** WhatsApp, email, country. Summary: phone · country.
   - **Payment:** today's Payment block minus Amount/Status rows that repeat the header, plus
     Payment attempts. Summary: "Paid", "Deposit paid", "Cash due", "Awaiting payment". Opens by
     itself under an exception.
   - **Vehicle & pickup:** the two existing toggles, unchanged.
   - **History:** today's Activity list.
6. **Refund / Cancel:** as today, last in the body.

Fold state is per open of the pane (not remembered). Folds use `<details>/<summary>` so they work
with the keyboard and survive `morphSheet` diff-renders.

## Map

- **Trigger:** "Map" button on the Itinerary heading. Opens a dialog over the queue, about 900px
  wide on desktop and full screen on a phone.
- **Content:** the Google map fills most of the dialog. A key down the side lists each leg's date,
  short places and road, in the same colours as the line (default road and local road visibly
  different).
- **Drawing:** reuse `drawItinRoute`'s approach (`computeRoutes` per connected run, `avoidTolls` for
  a `no_tolls` leg, numbered pins via `mapPins`). The booking's runs are built from `input.stops`,
  `gaps`, `through` and `routeVariants` (trip) or `from`/`to`/`routeVariant` (single). Gap legs are
  not drawn.
- **Own state:** the booking map gets its own map instance and request counter. `drawItinRoute`
  today writes the shared `_mapMap` / `_mapReqSeq` / `_mapPolylines`, so either it is
  parameterised to take that state, or the booking map has a sibling function. The plan picks one.
- **Cost:** Maps JS loads on the first press, never on pane open. One `computeRoutes` per connected
  run. A second press on the same booking in the same page session reuses the drawn result.
  `MAPS_LIVE_ON` gating is unchanged, so test sites stay off unless the pill is on.
- **Failure:** no key or maps off → today's "Google map is off on test sites" note. An unroutable
  run is dropped and the rest still draw; if none draw, "Couldn't map this route — check the place names."
- **Close:** ✕, Escape and scrim click; focus returns to the Map button. Must sit above the side
  rail (known gotcha: ops dialogs have rendered under it).

## Out of scope

- Per-leg pickup times or bags on trips (the booking doesn't store them; booking-page change).
- Any change to stages, the sticky foot, or what the status buttons do.
- Shortening addresses server-side (`quote/shortPlace.ts`) or changing stored stops.
- A wider pane or a full-page booking view.
- The ride-board sheet (`boardSheetHtml`).

## Testing

- **Unit (web-tests/unit, `loadFn` pattern):**
  - the stub values: vehicle name, guests sub-line with and without the split, bags "not asked"
  - exception detection: paid, deposit, cash due, awaiting
  - road chip per leg, including through-runs and gaps
  - short place = before the first comma
  - booking → map runs (trip with a gap, a through-stop and a `no_tolls` leg; a single on `no_tolls`)
- **E2E (Playwright, maps stubbed as today):**
  - a trip booking opens with the vehicle in the header and the itinerary first
  - Payment is closed on a paid booking and open on a deposit booking
  - the Map button opens and closes the dialog, with focus returned
  - nothing is lost: every field from today's pane is present somewhere in the DOM
- **Existing specs** that read the Trip/Payment blocks or the pipe will need their selectors updated.
  That is expected churn, not new behaviour.
- **Browser check** in the preview: a multi-stop, a single, a deposit, a pay-on-the-day, an
  awaiting-payment booking, and a phone-width pane.
- Gate: `cd api && npm run check` and `npm run test:all` green before every commit; `npm run stamp`
  if any root asset changes.

## Risks

- **`ops-ui.html` is the hot file.** Many sessions edit it, so keep the PR small and land it quickly.
  If a large refactor of the same render is in flight, rebase onto it rather than conflict-merge.
- **morphdom and `<details>`:** a diff-render must not snap an open fold shut. Either key the open
  state in render state or let `onBeforeElUpdated` keep `open`. Covered by an e2e that opens
  Payment, triggers a refresh, and checks it stays open.
- **Maps billing:** the dialog is press-only and gated by `MAPS_LIVE_ON`. E2E stubs `google.maps`
  as the quote-tool tests do.
