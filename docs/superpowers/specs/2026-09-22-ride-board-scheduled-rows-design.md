# Scheduled taxis on the ride board — design

**Status:** approved by owner 2026-09-22 (prototype v3: https://claude.ai/artifact/C4ytF21iqPRwsLvD9nZ35t)

## Why
The board showed only lists travellers start — in practice seed data — while the Wed/Sat taxis we
actually run, and that real customers book, appeared nowhere on it. The owner's requirements:

1. On a phone, with little space, show **both** customer-created rides and the scheduled taxis.
2. A traveller must **never confuse** a fixed-schedule taxi with a customer-created ride.
3. It must be **clear when** each ride goes.
4. Existing rides must be **legible and easy to join**.

Six prototypes that stacked the two as separate sections failed (1): whichever came second sat
too deep on a phone. The answer is one list.

## What changes (board.html / board.js only — no API, pricing, schema or config)
- **One day-grouped list.** Scheduled departures for the next **14 days** (tomorrow onward — a
  van leaving today is not an offer, the same rule search.html applies) are merged into the
  board's existing day groups, ordered within a day by when they leave: a scheduled taxi by its
  clock time, a list by the start of its window (7:00 / 13:00).
- **What runs** comes from the @generated catalogue (`TRANSFERS.sharedOption`); **which days**
  from `shared-day.js` (`CHSharedDay.runsOn`, the helper search.html uses). One row per van;
  filtered to a later stop (Negombo → Sigiriya), the row is that stop — its time and pickup.
- **A scheduled row cannot be read as a list**, on five counts at once: a **clock time** (09:00,
  not a window — this supersedes #621's "always a window" for scheduled rows only), the **solid
  teal clock mark** (lists show faces), **"Scheduled · always runs · <pickup>"**, an **exact
  price** ($22.99, not "≈ $23 each"), and **no button** — the whole row links to
  `search.html?from=&to=&date=`, where the seat is sold. On a phone it is one line (~66px):
  `[clock] 09:00  Ella → Yala / Scheduled   $22.99 ›`.
- **Join** (was "Hop on") is the traveller-ride verb — on the row, the ride sheet ("Join — seats
  open", "Join this ride") and search.html's board-ride card. On a phone **Join is the one solid
  button in the list**; every other action stays a text link.
- **When a ride is decided.** A gathering row shows its cutoff as a Sri Lanka date: "decided Wed
  12 Aug" — under the seat count on a laptop, on the time line on a phone (where the duration and
  the price's "each" give way so the line never wraps down to 360px).
- **Day headings** carry Today / Tomorrow / This Friday / Next week.
- **The window's end** says so: "Scheduled taxis keep running every Wed & Sat after <date>",
  placed before the first day past the 14, with a "Pick a date ›" link to search once a route is
  chosen (search.html without a route falls back to the airport, so there is no link unfiltered).
- **A two-line key** above the list: "Scheduled taxi — fixed time, always runs" / "Traveller
  ride — runs if 3 join · $0 until then". It explains; it does not filter.
- **Intro** is one sentence; the payment-promise box and the "$0 to add your name" scribble go
  (the key and the FAQ carry that promise).
- The route filter also offers every scheduled stop → destination pair.
- "My rides" shows only your lists — never scheduled rows.

## Not in this change
- **Seats booked / left on a scheduled row.** Nothing public exposes departure inventory; that is
  its own backend step if wanted. Rows say "always runs" instead.
- Analytics for scheduled-row clicks.
- Seed lists on scheduled routes (owner decision, separate).

## Tests
- `web-tests/unit/ride-board-scheduled.test.js` — vans from the catalogue, rows inside the window
  on Wed/Sat only and never today, later-stop filtering, day ordering, where the window line goes,
  the decided date in Colombo time, relative day labels, Join.
- `web-tests/e2e/ride-board-scheduled.spec.js` — on a 375px phone: scheduled rows on Wed/Sat only,
  one short line, no button; Join the only solid button; decided date visible and unclipped; the
  window line before later rides; no horizontal overflow. Filtered and unscheduled routes.
- Existing board specs updated for "Join" and scoped to traveller-ride groups
  (`.rw-group:has(.rw)`), since scheduled days now add groups of their own.
