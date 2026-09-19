# Ride Board as rows — design

**Status:** approved by owner 2026-09-18 (mockup v4: https://claude.ai/artifact/W5jEPmRTV6FqTSawa6AnX5)

## Why
Each ride card on `board.html` is ~550px tall, mostly roster and quote. A laptop shows three
rides, a phone shows one, and comparing rides means reading each card. A traveller is asking one
question — "is there a van going my way, on my date?" — which is five facts: departure window,
route, who's in, seat price, action. Rows put those in the same column on every ride.

## What changes (board list only)
- Rides render as **rows grouped by departure day** (day heading, then that day's rides; morning
  before afternoon). Days sort ascending.
- A row shows: **window** (`7–9 am` / `1–3 pm` — always the window, never a pinned clock time),
  **route** (display face) with **duration only** beneath (`~4h`), **who's in** (up to 4 avatars
  with flags + `+N`) with a **coloured seat state**, **seat price** (`≈ $19 each`), and **one
  action**.
- Seat state is one signal, coloured: amber `3 of 4 in · needs 1 more` while gathering; green
  `Locked in · N seats left` once the minimum is reached or the list is confirmed; grey `Full`.
  No pill, no dots, no bar, no "IT'S ON" stamp.
- Action rules (unchanged semantics from #597/#599 — the server refuses joins past the cutoff):
  - yours → **View your ride**
  - full and not yours → **Start another van** (`data-again`, no `data-view`)
  - confirmed (cutoff passed) → **See who's going**
  - otherwise (gathering, including minimum reached) → **Hop on**
  All non-full actions open the ride sheet (`data-view`); the sheet carries the join button and
  the money story. The whole row also opens the sheet (click, Enter, Space).
- A ride you're on is tinted teal with a teal left edge.
- **Start a ride +** is one button in the filter bar (desktop/tablet). On phones the existing
  sticky start bar (#565) does that job; the filter-bar button is hidden there.
- The trailing "Your ride's not up here?" tile is removed. When **both** route filters are set, a
  single invite row closes the list: "Not your day? Start a van on A → B for your date" →
  create modal prefilled with the route.
- Layouts: desktop one line per ride; ≤1020px route and seats stack in one cell; ≤640px two-line
  rows (route + price, window + duration, faces + state + a text-link action).
- The phone "Show N more rides" cap is removed (rows are ~90px; the cap existed for tall cards).
- The loading skeleton becomes row-shaped.

## Not changing
Ride detail sheet, join/create modals, payments, API, the money promise in the intro, the start
bar's ghost style (its test pins "joining stays the loudest action").

## Deferred
Route-first grouping when nothing is filtered — decide from real usage.

## Tests
- Unit (pure helpers on `window.RideBoard`): `windowLabel`, `durationOf`, `groupByDay`, `rowState`.
- e2e: existing card specs move to `.rw` selectors with updated wording; new
  `ride-board-rows.spec.js` pins day grouping + windows, no column overlap at tablet width, row
  height and hidden filter-bar button on phones, and the route-filtered invite.
- `display-weight-and-icon-stroke` pins `.rw-places` and `.rw-price b` on the display face.
